"use client";

import { useState, useCallback } from "react";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, TouchSensor,
  useSensor, useSensors, DragOverlay,
} from "@dnd-kit/core";
import {
  SortableContext, sortableKeyboardCoordinates,
  verticalListSortingStrategy, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Phone, Clock, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";

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
  status: string;
  next_follow_up: string | null;
  justificativa_ia: string | null;
  resumo_ia: string | null;
  ia_last_analyzed_at: string | null;
  created_at: string;
}

interface KanbanBoardProps {
  leads: Lead[];
  columns: { id: string; label: string; color: string }[];
  onLeadClick: (lead: Lead) => void;
  formatPhone: (jid: string) => string;
  onLeadsUpdated?: (leads: Lead[]) => void;
}

export default function KanbanBoard({ leads, columns, onLeadClick, formatPhone, onLeadsUpdated }: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<number | null>(null);
  const [localLeads, setLocalLeads] = useState<Lead[]>(leads);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 15 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = useCallback(async (event: any) => {
    const { active, over } = event;
    if (!over) { setActiveId(null); return; }

    const leadId = active.id as number;
    const overId = over.id;

    let newStatus = columns.find(c => c.id === overId) ? overId : null;
    if (!newStatus) {
      const overLead = localLeads.find(l => l.id === overId);
      if (overLead) newStatus = overLead.status || "novo";
    }

    if (newStatus && newStatus !== (localLeads.find(l => l.id === leadId)?.status || "novo")) {
      const updated = localLeads.map(l =>
        l.id === leadId ? { ...l, status: newStatus as string } : l
      );
      setLocalLeads(updated);
      if (onLeadsUpdated) onLeadsUpdated(updated);

      // Persist to DB (fire-and-forget, callback confirmed update)
      await supabase.from("leads_extraidos").update({ status: newStatus }).eq("id", leadId);
    }
    setActiveId(null);
  }, [columns, localLeads, onLeadsUpdated]);

  const displayLeads = activeId ? localLeads : leads;

  return (
    <div className="flex-1 w-full overflow-x-auto custom-scrollbar pb-8 cursor-default kanban-scroll-container mobile-safe-bottom">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={(e) => setActiveId(e.active.id as number)}
        onDragEnd={handleDragEnd}
      >
        <div className="flex gap-3 sm:gap-6 min-w-max p-2 h-full min-h-[calc(100vh-250px)]">
          {columns.map((col) => (
            <SortableContext
              key={col.id}
              items={displayLeads.filter(l => (l.status || "novo") === col.id).map(l => l.id)}
              strategy={verticalListSortingStrategy}
            >
              <KanbanColumn
                column={col}
                leads={displayLeads.filter(l => (l.status || "novo") === col.id)}
                onLeadClick={onLeadClick}
                formatPhone={formatPhone}
              />
            </SortableContext>
          ))}
        </div>
        <DragOverlay>
          {activeId ? (
            <KanbanCard
              lead={displayLeads.find(l => l.id === activeId)}
              isOverlay
              formatPhone={formatPhone}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

// --- Kanban Sub-components ---

function KanbanColumn({ column, leads, onLeadClick, formatPhone }: any) {
  const { setNodeRef } = useSortable({ id: column.id });

  const isHex = typeof column.color === "string" && column.color.startsWith("#");
  const hexStyle = isHex
    ? { backgroundColor: `${column.color}1a`, borderColor: `${column.color}33`, color: column.color }
    : undefined;

  return (
    <div className="w-[280px] sm:w-[320px] flex flex-col gap-4">
      <div
        className={cn("px-5 py-3 rounded-2xl border text-xs font-black uppercase tracking-widest flex items-center justify-between backdrop-blur-md shadow-lg", !isHex && column.color)}
        style={hexStyle}
      >
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
  const initials = (lead.nome_negocio || "UD").substring(0, 2).toUpperCase();

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
            {new Date(lead.next_follow_up).toLocaleString("pt-BR", { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
