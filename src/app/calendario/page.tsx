"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Header } from "@/components/layout/header";
// Header lê o title/icon do pathname mapeado em pageTitles — já adicionei /calendario lá.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  CalendarDays, Plus, Trash2, CheckCircle2, AlertCircle, X, Clock,
  Loader2, ChevronLeft, ChevronRight, RefreshCw, User, Bot, Send, Link2,
  ExternalLink, Users, Video, MapPin, Bell, Palette, AlignLeft, Eye,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ConnectGoogleDialog } from "@/components/connect-google-dialog";
import { CalendarStatusBar } from "@/components/calendar-status-bar";
import { SendFollowupDialog } from "@/components/send-followup-dialog";
import { GOOGLE_EVENT_COLORS } from "@/lib/google-calendar-colors";
import "./calendar-theme.css";
import dynamic from "next/dynamic";

const CalendarGrid = dynamic(
  () => import("./_components/CalendarGrid"),
  { ssr: false, loading: () => <CalendarSkeleton /> }
);

function CalendarSkeleton() {
  return (
    <div className="rounded-2xl border border-white/10 bg-secondary/20 p-1 sm:p-2 flex items-center justify-center" style={{ height: "calc(100vh - 240px)", minHeight: 520 }}>
      <div className="text-center text-muted-foreground">
        <div className="w-8 h-8 mx-auto animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <p className="text-xs mt-3">Carregando calendário…</p>
      </div>
    </div>
  );
}

type Appointment = {
  id: string;
  client_id: string;
  agent_id: number | null;
  lead_id: number | null;
  remote_jid: string;
  instance_name: string | null;
  google_event_id: string | null;
  title: string;
  description: string | null;
  service_name: string | null;
  start_at: string;
  end_at: string;
  status: "confirmed" | "tentative" | "cancelled" | "completed" | "no_show";
  created_by: "ia" | "manual" | "google_sync";
  cancelled_reason: string | null;
  // Campos espelho do Google Calendar
  location?: string | null;
  attendees?: { email: string; displayName?: string; responseStatus?: string }[] | null;
  all_day?: boolean;
  visibility?: "default" | "public" | "private" | "confidential";
  color_id?: string | null;
  html_link?: string | null;
  recurrence?: string[] | null;
  conference_data?: any;
  organizer_email?: string | null;
  metadata?: Record<string, any> | null;
};

type Agent = { id: number; name: string; is_scheduler: boolean; google_connected?: boolean; google_email?: string | null };

type ViewMode = "day" | "week" | "month" | "agenda";

const STATUS_LABELS: Record<Appointment["status"], { label: string; color: string }> = {
  confirmed: { label: "Confirmado", color: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  tentative: { label: "Tentativo", color: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30" },
  cancelled: { label: "Cancelado", color: "bg-red-500/15 text-red-400 border-red-500/30" },
  completed: { label: "Concluído", color: "bg-blue-500/15 text-blue-300 border-blue-500/30" },
  no_show:   { label: "Não compareceu", color: "bg-orange-500/15 text-orange-300 border-orange-500/30" },
};

function startOfDay(d: Date) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d: Date) { const x = new Date(d); x.setHours(23,59,59,999); return x; }
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfWeek(d: Date) { const x = startOfDay(d); x.setDate(x.getDate() - x.getDay()); return x; }
function startOfMonth(d: Date) { const x = startOfDay(d); x.setDate(1); return x; }
function endOfMonth(d: Date) { const x = startOfMonth(d); x.setMonth(x.getMonth() + 1); x.setDate(0); x.setHours(23,59,59,999); return x; }

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}
function fmtDateLong(d: Date) {
  return d.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
}

export default function CalendarioPage() {
  // Default = "month" (mais útil pra ter visão geral do que vem).
  // Antes era "day" → usuário tinha que navegar dia a dia pra ver o mês.
  const [view, setView] = useState<ViewMode>("month");
  const [anchor, setAnchor] = useState<Date>(new Date());
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [filterAgent, setFilterAgent] = useState<string>("all");
  // Default "all" — mostra TUDO (ativos + cancelados + concluídos). Usuário
  // pode filtrar pra "Ativos" se quiser esconder cancelados/concluídos.
  // Antes era "active" → cancelados sumiam e usuário não conseguia limpar.
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Appointment | null>(null);
  // Horário pré-selecionado ao clicar/arrastar num slot vazio da grade.
  const [initialStart, setInitialStart] = useState<Date | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string; link?: string | null } | null>(null);
  // Conectar Google + Enviar follow-up
  const [connectGoogleOpen, setConnectGoogleOpen] = useState(false);
  const [sendFollowupAppt, setSendFollowupAppt] = useState<Appointment | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const { from, to } = useMemo(() => {
    if (view === "day") return { from: startOfDay(anchor), to: endOfDay(anchor) };
    if (view === "week") return { from: startOfWeek(anchor), to: endOfDay(addDays(startOfWeek(anchor), 6)) };
    if (view === "agenda") return { from: startOfDay(anchor), to: endOfDay(addDays(anchor, 30)) };
    // Mês: amplia pras semanas "vazadas" da grade (domingo da 1ª linha →
    // sábado da última) pra não sumir evento no início/fim do mês.
    const gridStart = startOfWeek(startOfMonth(anchor));
    const gridEnd = endOfDay(addDays(startOfWeek(endOfMonth(anchor)), 6));
    return { from: gridStart, to: gridEnd };
  }, [view, anchor]);

  const loadAgents = useCallback(async () => {
    try {
      const r = await fetch("/api/agents", { cache: "no-store" });
      const d = await r.json();
      if (d.ok) setAgents(d.agents || []);
    } catch {
      // Fallback silencioso — UI lida bem com agents=[]
      setAgents([]);
    }
  }, []);

  const loadAppointments = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
      });
      if (filterAgent !== "all") params.set("agent_id", filterAgent);
      if (filterStatus !== "active" && filterStatus !== "all") params.set("status", filterStatus);
      const r = await fetch(`/api/appointments?${params.toString()}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setToast({ kind: "err", text: d.error || "Erro ao carregar" });
        setAppointments([]);
      } else {
        let list: Appointment[] = d.appointments || [];
        if (filterStatus === "active") list = list.filter(a => a.status !== "cancelled");
        setAppointments(list);
      }
    } catch (e: any) {
      setToast({ kind: "err", text: e.message });
    } finally {
      setLoading(false);
    }
  }, [from, to, filterAgent, filterStatus]);

  /**
   * Sync com Google Calendar: chama /api/appointments/sync que puxa eventos
   * em tempo real do Google de TODOS os agentes scheduler conectados e
   * mergeia no banco local. Depois recarrega a lista.
   */
  const syncGoogle = useCallback(async (silent = false) => {
    setSyncing(true);
    try {
      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
      });
      if (filterAgent !== "all") params.set("agent_id", filterAgent);
      const r = await fetch(`/api/appointments/sync?${params.toString()}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        if (!silent) setToast({ kind: "err", text: d.error || "Falha ao sincronizar Google" });
      } else {
        setLastSyncedAt(new Date());
        if (!silent && d.synced > 0) {
          setToast({ kind: "ok", text: `${d.synced} eventos sincronizados do Google` });
        }
        await loadAppointments();
      }
    } catch (e: any) {
      if (!silent) setToast({ kind: "err", text: e.message });
    } finally {
      setSyncing(false);
    }
  }, [from, to, filterAgent, loadAppointments]);

  useEffect(() => { loadAgents(); }, [loadAgents]);

  // Detecta se o usuário é admin (não-impersonando) — controla visibilidade
  // do seletor de modelo IA no modal de follow-up.
  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setIsAdmin(!!d?.isAdmin && !d?.impersonating))
      .catch(() => setIsAdmin(false));
  }, []);

  // Quando o filtro/período muda: faz sync silencioso com Google + carrega.
  // O sync é best-effort — se falhar (agente sem OAuth), só carrega do local.
  useEffect(() => {
    syncGoogle(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from.getTime(), to.getTime(), filterAgent]);

  // Polling em background: a cada 60s revalida com Google enquanto a aba tá ativa.
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) syncGoogle(true);
    }, 60_000);
    return () => clearInterval(id);
  }, [syncGoogle]);

  function moveAnchor(direction: -1 | 1) {
    if (view === "day") setAnchor(addDays(anchor, direction));
    else if (view === "week") setAnchor(addDays(anchor, direction * 7));
    else {
      const x = new Date(anchor);
      x.setMonth(x.getMonth() + direction);
      setAnchor(x);
    }
  }

  async function patchAppointment(id: string, patch: Record<string, any>) {
    try {
      const r = await fetch(`/api/appointments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setToast({ kind: "err", text: d.error || "Falha ao atualizar" });
        return;
      }
      setToast({ kind: "ok", text: "Atualizado" });
      loadAppointments();
    } catch (e: any) {
      setToast({ kind: "err", text: e.message });
    }
  }

  // Cancela um appointment ativo. Soft delete: vira status=cancelled, evento
  // no Google é removido. Mantém row pra histórico.
  async function deleteAppointment(id: string) {
    if (!confirm("Cancelar este agendamento?\n\nIsso vai marcar como cancelado e REMOVER o evento do Google Calendar.")) return;
    try {
      const r = await fetch(`/api/appointments/${id}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setToast({ kind: "err", text: d.error || "Falha ao cancelar" });
        return;
      }
      setToast({
        kind: "ok",
        text: d.google === false
          ? `Cancelado no sistema. ⚠ Google: ${d.google_error || "sem sync"}`
          : "Cancelado ✓ (sincronizado com Google)",
      });
      loadAppointments();
    } catch (e: any) {
      setToast({ kind: "err", text: e.message });
    }
  }

  // Excluir DEFINITIVO a partir do editor (estilo Google): remove do Google
  // Calendar (DELETE soft cancela no Google + marca cancelled) e em seguida
  // apaga a row do painel (hard). Resultado: some da agenda E do Google.
  async function deleteFromDialog(id: string) {
    if (!confirm("Excluir este agendamento?\n\nIsso remove do Google Calendar e do painel.")) return;
    try {
      const r1 = await fetch(`/api/appointments/${id}`, { method: "DELETE" });
      const d1 = await r1.json().catch(() => ({}));
      // Depois de cancelado (status=cancelled), o hard delete é permitido.
      await fetch(`/api/appointments/${id}?hard=true`, { method: "DELETE" }).catch(() => {});
      setToast({
        kind: "ok",
        text: d1?.google === false
          ? `Excluído do painel. ⚠ Google: ${d1?.google_error || "sem sync"}`
          : "Agendamento excluído ✓ (removido do Google Calendar)",
      });
      loadAppointments();
    } catch (e: any) {
      setToast({ kind: "err", text: e.message });
    }
  }

  // Hard delete — só permitido pra agendamentos já cancelados/concluídos.
  // Remove a row do banco permanentemente.
  async function purgeAppointment(id: string) {
    if (!confirm("Apagar permanentemente este agendamento?\n\nIsso REMOVE do sistema (não pode desfazer). Use pra limpar agendamentos cancelados/concluídos que poluem a lista.")) return;
    try {
      const r = await fetch(`/api/appointments/${id}?hard=true`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setToast({ kind: "err", text: d.error || "Falha ao apagar" });
        return;
      }
      setToast({ kind: "ok", text: "Apagado permanentemente ✓" });
      loadAppointments();
    } catch (e: any) {
      setToast({ kind: "err", text: e.message });
    }
  }

  // Agrupa appointments por dia pra renderização
  const grouped = useMemo(() => {
    const m = new Map<string, Appointment[]>();
    for (const a of appointments) {
      const key = startOfDay(new Date(a.start_at)).toISOString();
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(a);
    }
    return Array.from(m.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, list]) => ({ day: new Date(k), items: list.sort((a, b) => a.start_at.localeCompare(b.start_at)) }));
  }, [appointments]);

  const today = startOfDay(new Date()).getTime();

  // Mover/redimensionar: update otimista + PATCH (que sincroniza no Google e
  // recarrega). Em falha, o reload do patchAppointment reverte pro estado real.
  const onEventDropOrResize = useCallback(async ({ event, start, end }: any) => {
    const a = event.resource as Appointment;
    if (a.status === "cancelled") return;
    const start_at = new Date(start).toISOString();
    const end_at = new Date(end).toISOString();
    setAppointments((prev) => prev.map((x) => (x.id === a.id ? { ...x, start_at, end_at } : x)));
    await patchAppointment(a.id, { start_at, end_at });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSelectSlot = useCallback((slot: any) => {
    setEditing(null);
    setInitialStart(new Date(slot.start));
    setCreateOpen(true);
  }, []);

  const onSelectEvent = useCallback((event: any) => {
    setEditing(event.resource as Appointment);
    setInitialStart(null);
    setCreateOpen(true);
  }, []);

  return (
    <div className="flex flex-col h-full">
      <Header />

      <div className="flex-1 overflow-auto p-3 md:p-6 space-y-4">
        {/* Barra de status — modelo IA + agente + instância */}
        <CalendarStatusBar agents={agents} isAdmin={isAdmin} />

        {/* Barra de controle */}
        <div className="flex flex-wrap gap-2 items-center">
          <div className="flex items-center gap-1 border border-white/10 rounded-lg p-0.5 bg-secondary/30">
            <Button variant={view === "day" ? "default" : "ghost"} size="sm" onClick={() => setView("day")} className="text-xs h-7">Dia</Button>
            <Button variant={view === "week" ? "default" : "ghost"} size="sm" onClick={() => setView("week")} className="text-xs h-7">Semana</Button>
            <Button variant={view === "month" ? "default" : "ghost"} size="sm" onClick={() => setView("month")} className="text-xs h-7">Mês</Button>
            <Button variant={view === "agenda" ? "default" : "ghost"} size="sm" onClick={() => setView("agenda")} className="text-xs h-7">Agenda</Button>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={() => moveAnchor(-1)} className="w-7 h-7"><ChevronLeft className="w-4 h-4" /></Button>
            <button onClick={() => setAnchor(new Date())} className="text-xs font-medium text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-white/5">
              {view === "day" ? fmtDateLong(anchor) : view === "week" ? `${fmtDate(from.toISOString())} – ${fmtDate(to.toISOString())}` : anchor.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}
            </button>
            <Button variant="ghost" size="icon" onClick={() => moveAnchor(1)} className="w-7 h-7"><ChevronRight className="w-4 h-4" /></Button>
            <Button variant="ghost" size="icon" onClick={() => setAnchor(new Date())} title="Hoje" className="w-7 h-7"><RefreshCw className="w-3.5 h-3.5" /></Button>
          </div>

          {/* Filtros: passa o label CALCULADO pro SelectValue. Antes ele
              tentava inferir o texto do filho que estava com value selecionado,
              mas em algumas versões do Radix isso fica vazio e cai no
              `placeholder` mostrando texto cru ("all"). Passar `children`
              explícito garante o rótulo certo SEMPRE. */}
          {(() => {
            const STATUS_LABELS: Record<string, string> = {
              all: "Todos status",
              active: "Ativos",
              confirmed: "Confirmados",
              completed: "Concluídos",
              cancelled: "Cancelados",
              no_show: "Não compareceu",
            };
            return (
              <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v || "all")}>
                <SelectTrigger className="h-8 text-xs w-[160px]">
                  <SelectValue placeholder="Status">{STATUS_LABELS[filterStatus] || "Status"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos status</SelectItem>
                  <SelectItem value="active">Ativos (não cancelados)</SelectItem>
                  <SelectItem value="confirmed">Confirmados</SelectItem>
                  <SelectItem value="completed">Concluídos</SelectItem>
                  <SelectItem value="cancelled">Cancelados</SelectItem>
                  <SelectItem value="no_show">Não compareceu</SelectItem>
                </SelectContent>
              </Select>
            );
          })()}

          {agents.length > 0 && (() => {
            const agentLabel = filterAgent === "all"
              ? "Todos os agentes"
              : (agents.find(a => String(a.id) === filterAgent)?.name || "Agente");
            return (
              <Select value={filterAgent} onValueChange={(v) => setFilterAgent(v || "all")}>
                <SelectTrigger className="h-8 text-xs w-[180px]">
                  <SelectValue placeholder="Agente">{agentLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os agentes</SelectItem>
                  {agents.map(a => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            );
          })()}

          <div className="ml-auto flex items-center gap-2">
            {/* Badge de status — verde se PELO MENOS UM agente tem Google
                conectado, vermelho se nenhum. Clica pra abrir o modal de
                conectar diretamente. */}
            {(() => {
              const connectedAgents = agents.filter(a => a.google_connected);
              const connectedCount = connectedAgents.length;
              const totalScheduler = agents.length;
              const ok = connectedCount > 0;
              const emails = Array.from(new Set(connectedAgents.map(a => a.google_email).filter(Boolean))) as string[];
              const firstEmail = emails[0];
              return (
                <button
                  onClick={() => setConnectGoogleOpen(true)}
                  className={cn(
                    "flex items-center gap-1.5 px-2 py-1 rounded-md border text-[10px] font-bold tracking-widest transition max-w-[260px]",
                    ok
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20"
                      : "bg-red-500/10 border-red-500/30 text-red-300 hover:bg-red-500/20 uppercase"
                  )}
                  title={
                    ok
                      ? `Eventos vão para: ${emails.join(", ") || "(conta conectada)"}. ${connectedCount}/${totalScheduler} agente(s) conectado(s). Clique pra gerenciar.`
                      : "Nenhum agente conectado ao Google Calendar — clique pra conectar"
                  }
                >
                  <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", ok ? "bg-emerald-400 animate-pulse" : "bg-red-400")} />
                  {ok
                    ? <span className="truncate normal-case">{firstEmail ? firstEmail : "Google conectado"}{emails.length > 1 ? ` +${emails.length - 1}` : ""}</span>
                    : "Sem Google"}
                </button>
              );
            })()}
            <span className="text-xs text-muted-foreground">
              {appointments.length} agendamento{appointments.length !== 1 ? "s" : ""}
              {lastSyncedAt && <span className="hidden md:inline"> • Sync {fmtTime(lastSyncedAt.toISOString())}</span>}
            </span>
            <Button onClick={() => syncGoogle(false)} size="sm" variant="outline" disabled={syncing} className="h-8" title="Sincronizar agora com Google Calendar">
              {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline ml-1">Google</span>
            </Button>
            <Button onClick={() => setConnectGoogleOpen(true)} size="sm" variant="outline" className="h-8" title="Conectar Google Calendar de um agente">
              <Link2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline ml-1">Conectar</span>
            </Button>
            <Button onClick={() => { setEditing(null); setInitialStart(null); setCreateOpen(true); }} size="sm" className="h-8">
              <Plus className="w-3.5 h-3.5 mr-1" /> Novo
            </Button>
          </div>
        </div>

        {/* Conteúdo */}
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
          </div>
        ) : view === "agenda" ? (
          grouped.length === 0 ? (
          <Card className="border-white/5">
            <CardContent className="py-12 text-center text-muted-foreground">
              <CalendarDays className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Nenhum agendamento no período.</p>
              <p className="text-xs mt-1">Clique em <span className="font-bold text-primary">+ Novo</span> pra criar um manual, ou deixe a IA agendar automaticamente.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {grouped.map(({ day, items }) => {
              const isToday = day.getTime() === today;
              const isPast = day.getTime() < today;
              const daysAhead = Math.round((day.getTime() - today) / (1000 * 60 * 60 * 24));
              // Tag de "quando vem" + cor por proximidade.
              // Hoje: roxo destaque. Amanhã/em ≤3 dias: verde (urgência saudável).
              // ≤7 dias: cyan (semana). >7 dias: cinza neutro.
              let aheadLabel: string | null = null;
              let aheadColor = "";
              if (!isPast && !isToday) {
                if (daysAhead === 1) { aheadLabel = "AMANHÃ"; aheadColor = "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/20"; }
                else if (daysAhead <= 3) { aheadLabel = `EM ${daysAhead} DIAS`; aheadColor = "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/20"; }
                else if (daysAhead <= 7) { aheadLabel = `EM ${daysAhead} DIAS`; aheadColor = "bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/20"; }
                else if (daysAhead <= 30) { aheadLabel = `EM ${daysAhead} DIAS`; aheadColor = "bg-white/5 text-muted-foreground ring-1 ring-white/10"; }
                else { aheadLabel = `EM ${Math.round(daysAhead / 7)} SEMANAS`; aheadColor = "bg-white/5 text-muted-foreground ring-1 ring-white/10"; }
              }
              return (
                <div key={day.toISOString()} className={cn(
                  // Wrapper visual: dias futuros próximos ganham borda esquerda colorida
                  !isPast && !isToday && daysAhead <= 7 && "border-l-2 border-emerald-500/40 pl-3 -ml-3",
                  isToday && "border-l-2 border-primary pl-3 -ml-3"
                )}>
                  <div className={cn(
                    "text-xs font-bold uppercase tracking-widest mb-2 px-1 flex items-center gap-2 flex-wrap",
                    isToday ? "text-primary" : isPast ? "text-muted-foreground/60" : "text-foreground"
                  )}>
                    <span>{fmtDateLong(day)}</span>
                    {isToday && <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary ring-1 ring-primary/20">HOJE</span>}
                    {aheadLabel && <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-mono", aheadColor)}>{aheadLabel}</span>}
                    <span className="text-[10px] font-mono text-muted-foreground/60 ml-auto">
                      {items.length} {items.length === 1 ? "evento" : "eventos"}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {items.map((a) => (
                      <Card key={a.id} className={cn("border-white/5 hover:border-white/10 transition-colors", a.status === "cancelled" && "opacity-50")}>
                        <CardContent className="p-3 flex items-start gap-3">
                          <div className="flex flex-col items-center justify-center text-xs font-mono shrink-0 w-14 py-1 rounded bg-secondary/50">
                            <Clock className="w-3 h-3 mb-0.5 text-muted-foreground" />
                            <span className="font-bold">{fmtTime(a.start_at)}</span>
                            <span className="text-[10px] text-muted-foreground">{fmtTime(a.end_at)}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-semibold truncate">{a.title}</span>
                              <Badge className={cn("text-[9px] font-bold border", STATUS_LABELS[a.status].color)}>
                                {STATUS_LABELS[a.status].label}
                              </Badge>
                              {a.created_by === "ia" && (
                                <Badge className="text-[9px] font-bold border bg-purple-500/15 text-purple-300 border-purple-500/30">
                                  <Bot className="w-2.5 h-2.5 mr-0.5" /> IA
                                </Badge>
                              )}
                              {a.google_event_id && (
                                <Badge className="text-[9px] font-bold border bg-blue-500/15 text-blue-300 border-blue-500/30">
                                  Google
                                </Badge>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                              <span className="font-mono">{a.remote_jid.replace("@s.whatsapp.net", "").replace("@g.us", "")}</span>
                              {a.service_name && <span>• {a.service_name}</span>}
                            </div>
                            {a.description && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{a.description}</p>}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {a.status === "confirmed" && (
                              <>
                                {!a.remote_jid.startsWith("google:") && (
                                  <Button variant="ghost" size="icon" className="w-7 h-7" title="Enviar follow-up no WhatsApp"
                                    onClick={() => setSendFollowupAppt(a)}>
                                    <Send className="w-3.5 h-3.5 text-primary" />
                                  </Button>
                                )}
                                <Button variant="ghost" size="icon" className="w-7 h-7" title="Marcar concluído"
                                  onClick={() => patchAppointment(a.id, { status: "completed" })}>
                                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                                </Button>
                                <Button variant="ghost" size="icon" className="w-7 h-7" title="Marcar não compareceu"
                                  onClick={() => patchAppointment(a.id, { status: "no_show" })}>
                                  <AlertCircle className="w-3.5 h-3.5 text-orange-400" />
                                </Button>
                              </>
                            )}
                            <Button variant="ghost" size="icon" className="w-7 h-7" title="Editar"
                              onClick={() => { setEditing(a); setCreateOpen(true); }}>
                              <RefreshCw className="w-3.5 h-3.5" />
                            </Button>
                            {/* Trash button — comportamento depende do status:
                                ATIVO (confirmed/tentative)  → cancela (soft) + sync Google
                                FINAL (cancelled/no_show/completed) → apaga permanente (hard) */}
                            {(a.status === "confirmed" || a.status === "tentative") ? (
                              <Button variant="ghost" size="icon" className="w-7 h-7" title="Cancelar (remove do Google também)"
                                onClick={() => deleteAppointment(a.id)}>
                                <Trash2 className="w-3.5 h-3.5 text-red-400" />
                              </Button>
                            ) : (
                              <Button variant="ghost" size="icon" className="w-7 h-7" title="Apagar permanentemente do sistema"
                                onClick={() => purgeAppointment(a.id)}>
                                <Trash2 className="w-3.5 h-3.5 text-red-500" />
                              </Button>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          )
        ) : (
          <CalendarGrid
            appointments={appointments}
            anchor={anchor}
            view={view}
            onNavigate={(d: Date) => setAnchor(d)}
            onView={(v) => setView(v)}
            onSelectSlot={onSelectSlot}
            onSelectEvent={onSelectEvent}
            onEventDropOrResize={onEventDropOrResize}
          />
        )}
      </div>

      <AppointmentDialog
        open={createOpen}
        onOpenChange={(v) => { setCreateOpen(v); if (!v) { setEditing(null); setInitialStart(null); } }}
        editing={editing}
        initialStart={initialStart}
        agents={agents}
        onSaved={() => { setCreateOpen(false); setEditing(null); setInitialStart(null); loadAppointments(); }}
        onToast={setToast}
        onDelete={deleteFromDialog}
      />

      <ConnectGoogleDialog
        open={connectGoogleOpen}
        onOpenChange={setConnectGoogleOpen}
        agents={agents.map(a => ({ id: a.id, name: a.name, google_connected: a.google_connected }))}
        onConnected={() => { setToast({ kind: "ok", text: "Aprove no Google e o agente fica conectado" }); loadAgents(); }}
      />

      <SendFollowupDialog
        open={!!sendFollowupAppt}
        onOpenChange={(v) => !v && setSendFollowupAppt(null)}
        appointment={sendFollowupAppt}
        isAdmin={isAdmin}
        onSent={() => { setToast({ kind: "ok", text: "Mensagem enviada" }); }}
      />

      {toast && (
        <div className={cn(
          "fixed bottom-20 lg:bottom-6 right-4 z-50 px-3 py-2 rounded-lg text-xs font-medium border max-w-sm",
          toast.kind === "ok" ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300" : "bg-red-500/10 border-red-500/30 text-red-300"
        )}>
          {toast.text}
          {toast.link && (
            <a href={toast.link} target="_blank" rel="noopener noreferrer" className="ml-2 underline font-bold inline-flex items-center gap-0.5 hover:opacity-80">
              <ExternalLink className="w-3 h-3" /> Abrir no Google
            </a>
          )}
          <button onClick={() => setToast(null)} className="ml-2 opacity-70 hover:opacity-100"><X className="w-3 h-3 inline" /></button>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Dialog de criar/editar agendamento
// ============================================================
function AppointmentDialog({
  open, onOpenChange, editing, initialStart, agents, onSaved, onToast, onDelete,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: Appointment | null;
  initialStart?: Date | null;
  agents: Agent[];
  onSaved: () => void;
  onToast: (t: { kind: "ok" | "err"; text: string; link?: string | null }) => void;
  onDelete: (id: string) => Promise<void> | void;
}) {
  const [title, setTitle] = useState("");
  const [remoteJid, setRemoteJid] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [agentId, setAgentId] = useState<string>("none");
  const [startAt, setStartAt] = useState("");
  const [durationMin, setDurationMin] = useState(60);
  const [allDay, setAllDay] = useState(false);
  const [visibility, setVisibility] = useState<"default" | "public" | "private" | "confidential">("default");
  const [colorId, setColorId] = useState<string>("");
  const [attendees, setAttendees] = useState<{ email: string; displayName?: string }[]>([]);
  const [attendeeInput, setAttendeeInput] = useState("");
  const [createMeet, setCreateMeet] = useState(false);
  // Lembretes customizados POR agendamento. Quando preenchido, sobrescreve
  // o scheduler_config.reminders default do agente.
  const [customReminders, setCustomReminders] = useState<{ offset_minutes: number; message: string }[]>([]);
  const [useCustomReminders, setUseCustomReminders] = useState(false);
  const [syncGoogle, setSyncGoogle] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) {
      setTitle(editing.title);
      setRemoteJid(editing.remote_jid);
      setServiceName(editing.service_name || "");
      setDescription(editing.description || "");
      setLocation(editing.location || "");
      setAgentId(editing.agent_id ? String(editing.agent_id) : "none");
      const s = new Date(editing.start_at);
      setStartAt(new Date(s.getTime() - s.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
      const diffMin = Math.round((new Date(editing.end_at).getTime() - s.getTime()) / 60000);
      setDurationMin(diffMin);
      setAllDay(!!editing.all_day);
      setVisibility(editing.visibility || "default");
      setColorId(editing.color_id || "");
      setAttendees(editing.attendees || []);
      setCreateMeet(!!editing.conference_data);
      setSyncGoogle(!!editing.google_event_id);
      const cr = (editing as any).metadata?.custom_reminders;
      setUseCustomReminders(Array.isArray(cr));
      setCustomReminders(Array.isArray(cr) ? cr : []);
    } else {
      setTitle("");
      setRemoteJid("");
      setServiceName("");
      setDescription("");
      setLocation("");
      // Prefere um agente JÁ conectado ao Google (pra sincronizar de cara);
      // senão cai no primeiro da lista.
      const connectedAgent = agents.find((a) => a.google_connected) || agents[0];
      setAgentId(connectedAgent?.id ? String(connectedAgent.id) : "none");
      // Usa o horário clicado na grade (initialStart) se houver; senão "agora"
      // arredondado pro próximo quarto de hora.
      const base = initialStart ? new Date(initialStart) : new Date();
      if (!initialStart) base.setMinutes(Math.ceil(base.getMinutes() / 15) * 15, 0, 0);
      setStartAt(new Date(base.getTime() - base.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
      setDurationMin(60);
      setAllDay(false);
      setVisibility("default");
      setColorId("");
      setAttendees([]);
      setCreateMeet(false);
      setSyncGoogle(true);
      setUseCustomReminders(false);
      setCustomReminders([]);
    }
    setAttendeeInput("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, agents, open, initialStart]);

  function addAttendee() {
    const email = attendeeInput.trim();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      onToast({ kind: "err", text: "Email inválido" });
      return;
    }
    if (attendees.some(a => a.email === email)) {
      setAttendeeInput("");
      return;
    }
    setAttendees([...attendees, { email }]);
    setAttendeeInput("");
  }

  function removeAttendee(email: string) {
    setAttendees(attendees.filter(a => a.email !== email));
  }

  async function save() {
    // Estilo Google Calendar: só o horário é obrigatório. Título vazio vira
    // "(Sem título)" e o CONTATO é opcional (evento de calendário não precisa
    // de WhatsApp). Sem isso, mover/editar evento sem contato dava erro.
    if (!startAt) {
      onToast({ kind: "err", text: "Defina o horário do agendamento" });
      return;
    }
    const titleFinal = title.trim() || "(Sem título)";
    const start = new Date(startAt);
    const end = allDay
      ? new Date(start.getTime() + 24 * 60 * 60 * 1000)
      : new Date(start.getTime() + durationMin * 60000);
    // Contato opcional: se preenchido, normaliza pra JID; se editando, preserva
    // o JID atual; se novo sem contato, usa um placeholder local (evento puro).
    const jidNormalized = remoteJid.trim()
      ? (remoteJid.includes("@") ? remoteJid : `${remoteJid.replace(/\D/g, "")}@s.whatsapp.net`)
      : (editing?.remote_jid || `manual:${Date.now()}@local`);

    setSaving(true);
    try {
      // Lembretes customizados ficam dentro de metadata.custom_reminders.
      // Worker tickReminders prioriza isso sobre o default do agente.
      // Array vazio = "não mandar nenhum lembrete neste agendamento".
      const validReminders = customReminders
        .filter(r => Number.isFinite(r.offset_minutes) && r.offset_minutes > 0 && r.message?.trim())
        .map(r => ({ offset_minutes: r.offset_minutes, message: r.message.trim() }));

      const metadata = {
        ...(editing?.metadata || {}),
        ...(useCustomReminders ? { custom_reminders: validReminders } : {}),
      };
      // Quando desativa custom, remove a chave pra cair no default do agente
      if (!useCustomReminders && (metadata as any).custom_reminders) {
        delete (metadata as any).custom_reminders;
      }

      const payload: any = {
        title: titleFinal,
        remote_jid: jidNormalized,
        service_name: serviceName.trim() || null,
        description: description.trim() || null,
        location: location.trim() || null,
        agent_id: agentId !== "none" ? Number(agentId) : null,
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        all_day: allDay,
        visibility,
        color_id: colorId || null,
        attendees,
        create_meet: createMeet,
        sync_google: syncGoogle,
        metadata,
      };
      const r = editing
        ? await fetch(`/api/appointments/${editing.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/appointments`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        onToast({ kind: "err", text: d.error || "Erro ao salvar" });
        return;
      }
      // Feedback de sincronização com o Google (antes era silencioso: o evento
      // era criado só no painel e o usuário não sabia que não foi pro Google).
      // O servidor resolve sozinho um agente conectado pra sincronizar; o
      // feedback reflete a resposta real (google_event_id = foi pro Google).
      const googleLink = d.appointment?.html_link || null;
      const acct = d.google_account ? ` (${d.google_account})` : "";
      if (syncGoogle && d.google_error) {
        onToast({ kind: "err", text: `Salvo no painel, mas NÃO foi pro Google: ${d.google_error}` });
      } else if (syncGoogle && d.appointment?.google_event_id) {
        onToast({ kind: "ok", text: `${editing ? "Atualizado" : "Criado"} ✓ no Google${acct}.`, link: googleLink });
      } else {
        onToast({ kind: "ok", text: editing ? "Atualizado ✓" : "Criado ✓ (somente no painel)" });
      }
      onSaved();
    } catch (e: any) {
      onToast({ kind: "err", text: e.message });
    } finally {
      setSaving(false);
    }
  }

  // Paleta de cores: fonte única compartilhada com a grade do calendário.
  const GOOGLE_COLORS = GOOGLE_EVENT_COLORS;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogTitle className="flex items-center justify-between px-6 pt-5 pb-3 shrink-0 border-b border-white/5">
          <span>{editing ? "Editar agendamento" : "Novo agendamento"}</span>
          {editing?.html_link && (
            <a
              href={editing.html_link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] font-bold text-blue-300 hover:text-blue-200 underline flex items-center gap-1"
            >
              <ExternalLink className="w-3 h-3" /> Abrir no Google
            </a>
          )}
        </DialogTitle>

        {/* Conteúdo scrollável */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 min-h-0">
          {/* Título — campo principal grande (estilo Google) */}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Adicionar título"
            className="w-full bg-transparent border-0 border-b border-white/15 focus:border-primary outline-none text-lg sm:text-xl font-medium pb-2 placeholder:text-muted-foreground/50"
          />

          {/* Data / hora */}
          <div className="flex gap-3 pt-1">
            <Clock className="w-5 h-5 mt-2 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type={allDay ? "date" : "datetime-local"}
                  value={allDay ? startAt.slice(0, 10) : startAt}
                  onChange={(e) => setStartAt(allDay ? e.target.value + "T00:00" : e.target.value)}
                  className="w-auto"
                />
                {!allDay && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">por</span>
                    <Input type="number" value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value))} min={5} max={480} className="w-20" />
                    <span className="text-xs text-muted-foreground">min</span>
                  </div>
                )}
              </div>
              <label className="flex items-center gap-2 text-xs cursor-pointer text-muted-foreground">
                <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
                <span>Dia inteiro</span>
              </label>
            </div>
          </div>

          {/* Convidados */}
          <div className="flex gap-3">
            <Users className="w-5 h-5 mt-2 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex gap-1">
                <Input
                  value={attendeeInput}
                  onChange={(e) => setAttendeeInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAttendee(); } }}
                  placeholder="Adicionar convidados (email)"
                  type="email"
                />
                <Button onClick={addAttendee} type="button" size="sm" variant="outline">Adicionar</Button>
              </div>
              {attendees.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {attendees.map(a => (
                    <span key={a.email} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/30 text-blue-300 flex items-center gap-1">
                      {a.email}
                      <button onClick={() => removeAttendee(a.email)} type="button" className="hover:text-red-400" title="Remover">
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <p className="text-[10px] text-muted-foreground mt-0.5">Google manda convite por email automaticamente.</p>
            </div>
          </div>

          {/* Google Meet */}
          {!editing && (
            <div className="flex gap-3">
              <Video className="w-5 h-5 mt-0.5 text-muted-foreground shrink-0" />
              <label className="flex items-center gap-2 text-sm cursor-pointer flex-1">
                <input type="checkbox" checked={createMeet} onChange={(e) => setCreateMeet(e.target.checked)} />
                <span>Adicionar videoconferência do Google Meet</span>
              </label>
            </div>
          )}

          {/* Local */}
          <div className="flex gap-3">
            <MapPin className="w-5 h-5 mt-2 text-muted-foreground shrink-0" />
            <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Adicionar local" className="flex-1" />
          </div>

          {/* Cor + Visibilidade */}
          <div className="flex gap-3">
            <Palette className="w-5 h-5 mt-1.5 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex flex-wrap gap-1.5 items-center">
                {GOOGLE_COLORS.map(c => (
                  <button
                    key={c.id || "default"}
                    type="button"
                    onClick={() => setColorId(c.id)}
                    title={c.name}
                    className={cn(
                      "w-6 h-6 rounded-full border-2 transition",
                      colorId === c.id ? "border-white scale-110" : "border-transparent hover:scale-105"
                    )}
                    style={{ backgroundColor: c.hex }}
                  />
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Eye className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <Select value={visibility} onValueChange={(v) => setVisibility(v as any)}>
                  <SelectTrigger className="h-8 text-xs w-[210px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Padrão do calendário</SelectItem>
                    <SelectItem value="public">Público</SelectItem>
                    <SelectItem value="private">Privado</SelectItem>
                    <SelectItem value="confidential">Confidencial</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Descrição + serviço + contato */}
          <div className="flex gap-3">
            <AlignLeft className="w-5 h-5 mt-2 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0 space-y-2">
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Adicionar descrição" />
              <Input value={serviceName} onChange={(e) => setServiceName(e.target.value)} placeholder="Serviço (opcional)" className="text-xs" />
              <div>
                <Input value={remoteJid} onChange={(e) => setRemoteJid(e.target.value)} placeholder="Contato: 5511999998888 ou JID completo" className="text-xs" />
                <p className="text-[10px] text-muted-foreground mt-0.5">Telefone com DDD ou JID completo (...@s.whatsapp.net)</p>
              </div>
            </div>
          </div>

          {/* Lembretes automáticos por agendamento ============================== */}
          <div className="flex gap-3">
            <Bell className="w-5 h-5 mt-2 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0 rounded-lg border border-amber-500/20 bg-amber-500/[0.05] p-3 space-y-2">
            <div className="flex items-start gap-2">
              <label className="flex items-center gap-2 text-sm font-bold cursor-pointer flex-1">
                <input
                  type="checkbox"
                  checked={useCustomReminders}
                  onChange={(e) => {
                    setUseCustomReminders(e.target.checked);
                    if (e.target.checked && customReminders.length === 0) {
                      // Pré-popula com 2 lembretes úteis (salão de beleza, etc)
                      setCustomReminders([
                        { offset_minutes: 1440, message: "Oi {nome}! Lembrete: amanhã às {hora_agendamento} temos seu agendamento de {servico}. Confirma a presença?" },
                        { offset_minutes: 10,   message: "{nome}, em 10 min é o seu horário ({servico}). Te esperamos!" },
                      ]);
                    }
                  }}
                />
                <span>Lembretes automáticos só deste agendamento</span>
              </label>
            </div>
            <p className="text-[10px] text-amber-200/70 leading-relaxed">
              Sobrescreve os lembretes padrão do agente. Use pra casos especiais
              (ex: salão de beleza com lembrete 2h e 10min antes; reunião online
              com link do Meet sendo reenviado X min antes).
            </p>

            {useCustomReminders && (
              <div className="space-y-2">
                {customReminders.length === 0 && (
                  <div className="text-[10px] text-muted-foreground italic">
                    Sem lembretes — este agendamento não vai disparar nenhuma mensagem.
                  </div>
                )}
                {customReminders.map((rem, idx) => (
                  <div key={idx} className="bg-white/[0.03] border border-white/10 rounded-md p-2 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={1}
                        max={10080}
                        value={rem.offset_minutes}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setCustomReminders(prev => prev.map((r, i) => i === idx ? { ...r, offset_minutes: v } : r));
                        }}
                        className="h-8 text-xs w-20"
                      />
                      <span className="text-[10px] text-muted-foreground">min antes</span>
                      <span className="text-[10px] text-muted-foreground/70 flex-1">
                        ({Math.floor(rem.offset_minutes / 60)}h {rem.offset_minutes % 60}min)
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="w-6 h-6"
                        onClick={() => setCustomReminders(prev => prev.filter((_, i) => i !== idx))}
                        type="button"
                        title="Remover lembrete"
                      >
                        <Trash2 className="w-3 h-3 text-red-400" />
                      </Button>
                    </div>
                    <Textarea
                      value={rem.message}
                      onChange={(e) => {
                        const v = e.target.value;
                        setCustomReminders(prev => prev.map((r, i) => i === idx ? { ...r, message: v } : r));
                      }}
                      rows={2}
                      className="text-xs resize-none"
                      placeholder="Use {nome}, {hora_agendamento}, {servico}, {meet_link}…"
                    />
                  </div>
                ))}
                <div className="flex flex-wrap gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-[10px]"
                    onClick={() => setCustomReminders(prev => [...prev, { offset_minutes: 60, message: "{nome}, em 1h é o seu agendamento ({servico})." }])}
                  >
                    <Plus className="w-3 h-3 mr-1" /> Adicionar lembrete
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-[10px]"
                    title="Adiciona um lembrete com {meet_link} pra reenviar o link da reunião"
                    onClick={() => setCustomReminders(prev => [...prev, {
                      offset_minutes: 10,
                      message: "{nome}, em 10 min começa nossa reunião 🔗 Link: {meet_link}",
                    }])}
                  >
                    + Link Meet
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Variáveis: <code className="text-amber-200">{`{nome} {hora_agendamento} {data_agendamento} {servico} {titulo} {meet_link} {local} {telefone} {email}`}</code>
                </p>
              </div>
            )}
            </div>
          </div>

          {/* Agente + sincronização */}
          <div className="flex gap-3">
            <User className="w-5 h-5 mt-2 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0 space-y-2">
              {agents.length > 0 && (
                <div>
                  <Select value={agentId} onValueChange={(v) => setAgentId(v || "none")}>
                    <SelectTrigger><SelectValue placeholder="Agente IA (responsável)" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Nenhum</SelectItem>
                      {agents.map(a => (
                        <SelectItem key={a.id} value={String(a.id)}>
                          {a.name} {a.is_scheduler && "🗓️"} {a.google_connected && "✓"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-muted-foreground mt-0.5">🗓️ scheduler · ✓ Google conectado</p>
                </div>
              )}
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input type="checkbox" checked={syncGoogle} onChange={(e) => setSyncGoogle(e.target.checked)} />
                <span>Sincronizar com Google Calendar do agente</span>
              </label>
            </div>
          </div>
        </div>

        {/* Rodapé fixo */}
        <div className="flex items-center justify-between gap-2 px-6 py-3 border-t border-white/5 shrink-0 bg-background/95 backdrop-blur">
          {editing ? (
            <Button
              variant="ghost"
              onClick={async () => { await onDelete(editing.id); onOpenChange(false); }}
              disabled={saving}
              className="text-red-400 hover:text-red-300 hover:bg-red-500/10 gap-1.5"
              title="Excluir agendamento (remove do Google Calendar também)"
            >
              <Trash2 className="w-4 h-4" /> Excluir
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancelar</Button>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null}
              {editing ? "Salvar" : "Criar"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
