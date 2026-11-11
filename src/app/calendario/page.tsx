"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Header } from "@/components/layout/header";
// Header lê o title/icon do pathname mapeado em pageTitles — já adicionei /calendario lá.
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  CalendarDays, Plus, Trash2, CheckCircle2, AlertCircle, X, Clock,
  Loader2, ChevronLeft, ChevronRight, RefreshCw, Bot, Send, Link2,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ConnectGoogleDialog } from "@/components/connect-google-dialog";
import { CalendarStatusBar } from "@/components/calendar-status-bar";
import { SendFollowupDialog } from "@/components/send-followup-dialog";
import AppointmentDialog from "./_components/AppointmentDialog";
import type { Agent, Appointment } from "./types";
import "./calendar-theme.css";
import styles from "./calendar.module.css";
import dynamic from "next/dynamic";

const CalendarGrid = dynamic(
  () => import("./_components/CalendarGrid"),
  { ssr: false, loading: () => <CalendarSkeleton /> }
);

function CalendarSkeleton() {
  return (
    <div className="calendar-grid flex items-center justify-center" role="status">
      <div className="text-center text-muted-foreground">
        <div className="w-8 h-8 mx-auto animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <p className="text-xs mt-3">Carregando calendário…</p>
      </div>
    </div>
  );
}

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

  const loadAppointments = useCallback(async (silent = false) => {
    // silent=true (sync/polling de background): NÃO ativa o loading spinner —
    // mantém o CalendarGrid montado e só troca os dados quando chegarem. Sem
    // isso, o polling de 60s desmontava o grid inteiro (piscar) a cada ciclo.
    if (!silent) setLoading(true);
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
        if (!silent) setToast({ kind: "err", text: d.error || "Erro ao carregar" });
        setAppointments([]);
      } else {
        let list: Appointment[] = d.appointments || [];
        if (filterStatus === "active") list = list.filter(a => a.status !== "cancelled");
        setAppointments(list);
      }
    } catch (e: any) {
      if (!silent) setToast({ kind: "err", text: e.message });
    } finally {
      if (!silent) setLoading(false);
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
        // SILENT: não ativa loading spinner — o grid fica montado e só
        // atualiza os dados. Assim o polling de 60s não pisca o calendário.
        await loadAppointments(true);
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
    <div className={cn(styles.calendar, "flex flex-col h-full min-h-0")}>
      <Header />

      <div className={cn(styles.content, "flex-1 overflow-auto min-h-0")}>
        <CalendarStatusBar agents={agents} isAdmin={isAdmin} />

        <section className={styles.workspace} aria-label="Agenda de agendamentos">
        <div className={styles.periodRow}>
          <div className={styles.period}>
            <h2 aria-live="polite">{view === "day" ? fmtDateLong(anchor) : view === "week" ? `${fmtDate(from.toISOString())} – ${fmtDate(to.toISOString())}` : anchor.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}</h2>
            <div className={styles.dateNavigation}>
              <Button variant="ghost" size="icon" onClick={() => moveAnchor(-1)} aria-label="Período anterior" className={styles.iconButton}><ChevronLeft className="w-4 h-4" /></Button>
              <Button variant="ghost" size="icon" onClick={() => moveAnchor(1)} aria-label="Próximo período" className={styles.iconButton}><ChevronRight className="w-4 h-4" /></Button>
              <Button variant="outline" size="sm" onClick={() => setAnchor(new Date())} className={styles.todayButton}>Hoje</Button>
            </div>
          </div>
          <Button onClick={() => { setEditing(null); setInitialStart(null); setCreateOpen(true); }} size="sm" className={styles.createButton}>
            <Plus className="w-4 h-4" /> Novo agendamento
          </Button>
        </div>

        <div className={styles.toolbar}>
          <div className={styles.viewModes} role="group" aria-label="Visualização do calendário">
            <Button variant="ghost" size="sm" aria-pressed={view === "day"} onClick={() => setView("day")}>Dia</Button>
            <Button variant="ghost" size="sm" aria-pressed={view === "week"} onClick={() => setView("week")}>Semana</Button>
            <Button variant="ghost" size="sm" aria-pressed={view === "month"} onClick={() => setView("month")}>Mês</Button>
            <Button variant="ghost" size="sm" aria-pressed={view === "agenda"} onClick={() => setView("agenda")}>Agenda</Button>
          </div>
          <div className={styles.filters}>

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
                <SelectTrigger className={styles.filterSelect} aria-label="Filtrar por status">
                  <SelectValue placeholder="Status">{STATUS_LABELS[filterStatus] || "Status"}</SelectValue>
                </SelectTrigger>
                <SelectContent className={styles.popover}>
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
                <SelectTrigger className={styles.filterSelect} aria-label="Filtrar por agente">
                  <SelectValue placeholder="Agente">{agentLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent className={styles.popover}>
                  <SelectItem value="all">Todos os agentes</SelectItem>
                  {agents.map(a => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            );
          })()}

          </div>
          <div className={styles.integrations}>
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
                  className={cn(styles.googleBadge, ok ? styles.googleConnected : styles.googleDisconnected)}
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
            <Button onClick={() => syncGoogle(false)} size="sm" variant="outline" disabled={syncing} className={styles.secondaryButton} title="Sincronizar agora com Google Calendar" aria-label="Sincronizar com Google Calendar">
              {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              <span>Sincronizar</span>
            </Button>
            <Button onClick={() => setConnectGoogleOpen(true)} size="sm" variant="outline" className={styles.secondaryButton} title="Conectar Google Calendar de um agente" aria-label="Conectar Google Calendar">
              <Link2 className="w-3.5 h-3.5" />
              <span>Conectar</span>
            </Button>
          </div>
        </div>

        <div className={styles.summary}>
          <span>{appointments.length} agendamento{appointments.length !== 1 ? "s" : ""} no período</span>
          <span>{syncing ? "Sincronizando com Google…" : lastSyncedAt ? `Última sincronização às ${fmtTime(lastSyncedAt.toISOString())}` : "Google Calendar"}</span>
        </div>

        <div className={styles.calendarBody}>
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
          </div>
        ) : view === "agenda" ? (
          grouped.length === 0 ? (
          <Card className={styles.emptyState}>
            <CardContent className="py-12 text-center text-muted-foreground">
              <CalendarDays className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Nenhum agendamento no período.</p>
              <p className="text-xs mt-1">Clique em <span className="font-bold text-primary">Novo agendamento</span> pra criar um manual, ou deixe a IA agendar automaticamente.</p>
            </CardContent>
          </Card>
        ) : (
          <div className={styles.agendaList}>
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
                <div key={day.toISOString()} className={styles.agendaDay}>
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
                      <Card key={a.id} className={cn(styles.agendaEvent, a.status === "cancelled" && "opacity-50")}>
                        <CardContent className={styles.agendaEventContent}>
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
                          <div className={styles.agendaActions}>
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
        </section>
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
