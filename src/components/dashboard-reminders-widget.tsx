"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Clock, Pencil, Plus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DashboardTaskForm } from "@/components/dashboard-task-form";
import { useClientSession } from "@/lib/use-session";
import { cn } from "@/lib/utils";
import type { DashboardTask, DashboardTasksResponse } from "@/types/dashboard-tasks";

interface LegacyReminder {
  id: number | string;
  nome_negocio: string;
  next_follow_up: string;
  lembrete_texto?: string | null;
  observacoes?: string | null;
}
interface LegacyResponse {
  overdue: LegacyReminder[];
  upcomingToday: LegacyReminder[];
  totalOverdue: number;
  totalUpcomingToday: number;
}
const emptyData: DashboardTasksResponse = {
  tasks: [], total: 0, counts: { pending: 0, overdue: 0, dueSoon: 0, upcoming: 0, completed: 0 },
};
const emptyLegacy: LegacyResponse = { overdue: [], upcomingToday: [], totalOverdue: 0, totalUpcomingToday: 0 };
const PAGE_SIZE = 8;

function countTask(task: DashboardTask | undefined, now: number): DashboardTasksResponse["counts"] {
  const counts = { ...emptyData.counts };
  if (!task) return counts;
  if (task.completed_at) counts.completed = 1;
  else {
    counts.pending = 1;
    const remaining = Date.parse(task.due_at) - now;
    if (remaining < 0) counts.overdue = 1;
    else if (remaining <= 30 * 60_000) counts.dueSoon = 1;
    else if (remaining <= 24 * 60 * 60_000) counts.upcoming = 1;
  }
  return counts;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function deadline(dueAt: string, now: number): { group: string; label: string; color: string } {
  const remaining = Date.parse(dueAt) - now;
  if (remaining < 0) return { group: "Atrasadas", label: "ATRASADO", color: "text-rose-300 border-rose-500/30 bg-rose-500/5" };
  if (remaining <= 30 * 60_000) return { group: "Em até 30 minutos", label: "EM ATÉ 30 MIN", color: "text-amber-300 border-amber-500/30 bg-amber-500/5" };
  if (remaining <= 24 * 60 * 60_000) return { group: "Próximas 24h", label: "EM ATÉ 24H", color: "text-cyan-300 border-cyan-500/20" };
  return { group: "Futuras", label: "AGENDADO", color: "text-muted-foreground border-border" };
}

export function DashboardRemindersWidget(): React.JSX.Element | null {
  const { session, loading } = useClientSession();
  if (loading || !session?.clientId) return null;
  return <TaskList key={session.clientId} />;
}

function TaskList(): React.JSX.Element {
  const [data, setData] = useState(emptyData);
  const [legacy, setLegacy] = useState(emptyLegacy);
  const [status, setStatus] = useState<"pending" | "completed">("pending");
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [setup, setSetup] = useState<"unknown" | "ready" | "missing">("unknown");
  const [loadError, setLoadError] = useState("");
  const [legacyError, setLegacyError] = useState("");
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<{ task: DashboardTask | null } | null>(null);
  const [now, setNow] = useState(Date.now);
  const alive = useRef(true);
  const saving = useRef(false);
  const request = useRef(0);
  const newButton = useRef<HTMLButtonElement>(null);
  const restoreEditorFocus = useRef(false);

  useEffect(() => {
    if (!editor && !busy && restoreEditorFocus.current) {
      restoreEditorFocus.current = false;
      newButton.current?.focus();
    }
  }, [editor, busy]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let inFlight = false;
    async function load(): Promise<void> {
      if (document.visibilityState === "hidden" || saving.current || inFlight) return;
      inFlight = true;
      const version = ++request.current;
      const current = () => !cancelled && version === request.current;
      setNow(Date.now());
      await Promise.all([
        (async () => {
          try {
            const res = await fetch(`/api/tasks?status=${status}&page=${page}&limit=${PAGE_SIZE}`, { signal: controller.signal, cache: "no-store" });
            const json = await res.json();
            if (!current()) return;
            if (!res.ok) {
              if (json.code === "TASKS_SETUP_REQUIRED") { setSetup("missing"); setData(emptyData); setLoadError(""); return; }
              throw new Error(json.error || "Não foi possível carregar as tarefas");
            }
            setSetup("ready");
            setLoadError("");
            setData(json);
            if (page > 0 && page * PAGE_SIZE >= json.total) setPage(Math.max(0, Math.ceil(json.total / PAGE_SIZE) - 1));
          } catch (err) {
            if (current()) setLoadError(err instanceof Error ? err.message : "Não foi possível carregar as tarefas");
          }
        })(),
        (async () => {
          try {
            const res = await fetch("/api/leads/reminders?limit=6", { signal: controller.signal, cache: "no-store" });
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || "Não foi possível carregar os lembretes das fichas");
            if (current()) { setLegacy(json); setLegacyError(""); }
          } catch {
            if (current()) setLegacyError("Não foi possível atualizar os lembretes das fichas.");
          }
        })(),
      ]);
      inFlight = false;
      if (current()) setLoading(false);
    }
    void load();
    const interval = setInterval(() => { void load(); }, 30_000);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { cancelled = true; controller.abort(); clearInterval(interval); document.removeEventListener("visibilitychange", visible); };
  }, [status, page, revision]);

  const mutate = useCallback(async (url: string, method: "POST" | "PATCH", input: object, success: string, previousTask?: DashboardTask): Promise<boolean> => {
    if (saving.current) return false;
    saving.current = true;
    request.current++;
    setBusy(true);
    setActionError("");
    setMessage("");
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Não foi possível salvar a tarefa");
      if (!alive.current) return false;
      if (json.task) {
        const task: DashboardTask = json.task;
        const old = method === "PATCH" ? data.tasks.find(t => t.id === task.id) ?? previousTask : undefined;
        const before = countTask(old, now);
        const after = countTask(task, now);
        const counts = { ...data.counts };
        for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = Math.max(0, counts[key] - before[key] + after[key]);
        const nextStatus = method === "POST" ? "pending" : status;
        const total = counts[nextStatus];
        const nextPage = method === "POST" ? 0 : Math.min(page, Math.max(0, Math.ceil(total / PAGE_SIZE) - 1));
        const visible = nextStatus === "completed" ? !!task.completed_at : !task.completed_at;
        const tasks = nextStatus === status && nextPage === page ? data.tasks.filter(t => t.id !== task.id) : [];
        if (visible) tasks.push(task);
        tasks.sort((a, b) => nextStatus === "completed" ? Date.parse(b.completed_at!) - Date.parse(a.completed_at!) || a.id.localeCompare(b.id) : Date.parse(a.due_at) - Date.parse(b.due_at) || a.id.localeCompare(b.id));
        setData({ tasks: tasks.slice(0, PAGE_SIZE), counts, total });
        setStatus(nextStatus);
        setPage(nextPage);
      } else if (url.startsWith("/api/leads/")) {
        const id = url.split("/")[3];
        setLegacy(prev => ({
          overdue: prev.overdue.filter(l => String(l.id) !== id),
          upcomingToday: prev.upcomingToday.filter(l => String(l.id) !== id),
          totalOverdue: Math.max(0, prev.totalOverdue - Number(prev.overdue.some(l => String(l.id) === id))),
          totalUpcomingToday: Math.max(0, prev.totalUpcomingToday - Number(prev.upcomingToday.some(l => String(l.id) === id))),
        }));
      }
      setMessage(success);
      return true;
    } catch (err) {
      if (alive.current) setActionError(err instanceof Error ? err.message : "Não foi possível salvar a tarefa");
      return false;
    } finally {
      saving.current = false;
      if (alive.current) { setBusy(false); setRevision(r => r + 1); }
    }
  }, [status, page, data, now]);

  const closeEditor = () => { restoreEditorFocus.current = true; setEditor(null); };
  const changeStatus = (next: "pending" | "completed") => {
    if (next === status && page === 0) return;
    setStatus(next); setPage(0); setData(prev => ({ ...prev, tasks: [], total: prev.counts[next] })); setLoading(true); setActionError(""); setMessage("");
  };
  const groups = new Map<string, DashboardTask[]>();
  for (const task of data.tasks) {
    const group = task.completed_at ? "Concluídas" : deadline(task.due_at, now).group;
    groups.set(group, [...(groups.get(group) || []), task]);
  }
  const oldReminders = [...legacy.overdue, ...legacy.upcomingToday];

  return (
    <Card className="glass-card border-none overflow-hidden">
      <CardContent className="p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-cyan-300" aria-hidden="true" />
            <div><h2 className="text-sm font-bold">Tarefas e lembretes</h2><p className="text-xs text-muted-foreground">Seu próximo passo, no horário certo.</p></div>
          </div>
          <Button ref={newButton} size="sm" disabled={setup !== "ready" || busy || !!editor} onClick={() => { setEditor({ task: null }); setActionError(""); }}>
            <Plus className="size-4" aria-hidden="true" /> Nova tarefa
          </Button>
        </div>

        {setup === "missing" && <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200 break-words">Para salvar tarefas livres e histórico, execute <code>migrations/017_dashboard_tasks.sql</code> no SQL Editor do Supabase. Os lembretes das fichas continuam disponíveis.</p>}
        {loadError && <div role="alert" className="text-xs text-destructive">{loadError} <Button size="sm" variant="ghost" onClick={() => setRevision(r => r + 1)}>Tentar novamente</Button></div>}
        {actionError && <p role="alert" className="text-xs text-destructive">{actionError}</p>}
        {message && <p role="status" className="text-xs text-emerald-300">{message}</p>}
        {editor && <DashboardTaskForm key={editor.task?.id || "new"} task={editor.task} busy={busy} onCancel={closeEditor} onSave={async input => {
          const saved = await mutate(editor.task ? `/api/tasks/${editor.task.id}` : "/api/tasks", editor.task ? "PATCH" : "POST", input, editor.task ? "Tarefa atualizada." : "Tarefa salva.", editor.task ?? undefined);
          if (saved) closeEditor();
        }} />}

        {setup !== "missing" && <>
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { label: "Atrasadas", count: data.counts.overdue, color: "text-rose-300" },
              { label: "Em até 30 min", count: data.counts.dueSoon, color: "text-amber-300" },
              { label: "De 30 min a 24h", count: data.counts.upcoming, color: "text-cyan-300" },
            ].map(c => <div key={c.label} className="rounded-lg border border-border p-2"><p className={cn("text-lg font-bold tabular-nums", c.color)}>{loading || loadError ? "—" : c.count}</p><p className="text-xs text-muted-foreground">{c.label}</p></div>)}
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Filtrar tarefas">
            <Button size="sm" variant={status === "pending" ? "secondary" : "ghost"} aria-pressed={status === "pending"} disabled={busy || !!editor} onClick={() => changeStatus("pending")}>Pendentes ({data.counts.pending})</Button>
            <Button size="sm" variant={status === "completed" ? "secondary" : "ghost"} aria-pressed={status === "completed"} disabled={busy || !!editor} onClick={() => changeStatus("completed")}>Concluídas ({data.counts.completed})</Button>
          </div>
          {loading ? <p role="status" className="text-sm text-muted-foreground py-3">Carregando tarefas…</p> : !loadError && data.tasks.length === 0 ? <p className="text-sm text-muted-foreground py-3">{status === "pending" ? "Nenhuma tarefa pendente. Adicione o que precisa fazer." : "As tarefas que você concluir ficam aqui."}</p> : null}
          {Array.from(groups, ([group, tasks]) => <section key={group} aria-label={group} className="space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground">{group}</h3>
            <ul className="space-y-2">{tasks.map(task => {
              const state = deadline(task.due_at, now);
              return <li key={task.id} className={cn("flex items-start gap-2 rounded-lg border p-2 text-foreground", task.completed_at ? "border-border" : state.color)}>
                <label className="flex size-11 shrink-0 cursor-pointer items-center justify-center">
                  <input type="checkbox" checked={!!task.completed_at} disabled={busy || loading || !!editor} onChange={() => { void mutate(`/api/tasks/${task.id}`, "PATCH", { completed: !task.completed_at }, task.completed_at ? "Tarefa reaberta." : "Tarefa concluída."); }} aria-label={`${task.completed_at ? "Reabrir" : "Concluir"}: ${task.text}`} className="size-5 accent-cyan-500 focus-visible:outline-2 focus-visible:outline-ring" />
                </label>
                <div className="flex-1 min-w-0 space-y-1 py-1">
                  <p className={cn("text-sm whitespace-pre-wrap break-words text-foreground", task.completed_at && "line-through text-muted-foreground")}>{task.text}</p>
                  {task.lead_id && <Link className="text-xs text-cyan-300 hover:underline break-words" href={`/leads?openLeadId=${task.lead_id}`}>{task.lead_name || `Lead #${task.lead_id}`}</Link>}
                  <p className="text-xs text-muted-foreground"><Clock className="inline size-3 mr-1" aria-hidden="true" /><time dateTime={task.due_at}>{fmtTime(task.due_at)}</time></p>
                  <p className={cn("text-[11px] font-semibold", task.completed_at ? "text-emerald-300" : state.color)}>{task.completed_at ? `CONCLUÍDA EM ${fmtTime(task.completed_at)}` : state.label}</p>
                </div>
                <Button variant="ghost" size="icon" className="size-11 shrink-0" disabled={busy || !!editor} aria-label={`Editar: ${task.text}`} onClick={() => { setEditor({ task }); setActionError(""); }}><Pencil className="size-4" aria-hidden="true" /></Button>
              </li>;
            })}</ul>
          </section>)}
          {data.total > PAGE_SIZE && <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Página {page + 1} de {Math.ceil(data.total / PAGE_SIZE)} · {data.total} tarefas</span>
            <div className="flex gap-1"><Button size="sm" variant="ghost" disabled={busy || loading || !!editor || page === 0} onClick={() => { setData(prev => ({ ...prev, tasks: [] })); setLoading(true); setPage(p => p - 1); }}>Anterior</Button><Button size="sm" variant="ghost" disabled={busy || loading || !!editor || (page + 1) * PAGE_SIZE >= data.total} onClick={() => { setData(prev => ({ ...prev, tasks: [] })); setLoading(true); setPage(p => p + 1); }}>Próxima</Button></div>
          </div>}
        </>}

        {(oldReminders.length > 0 || legacyError) && <section className="border-t border-border pt-3 space-y-2" aria-label="Lembretes das fichas">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-semibold">Lembretes das fichas</h3><Link href="/leads" className="text-xs text-cyan-300 hover:underline">Ver leads</Link></div>
          {legacyError && <p role="alert" className="text-xs text-destructive">{legacyError}</p>}
          {!legacyError && <p className="text-xs text-muted-foreground">{legacy.totalOverdue} atrasados · {legacy.totalUpcomingToday} nas próximas 24h.</p>}
          <p className="text-xs text-muted-foreground">Itens antigos; conclusão sem histórico. Novas tarefas ficam na lista acima.</p>
          <ul className="space-y-2">{oldReminders.map(lead => {
            const text = lead.lembrete_texto || lead.observacoes || "Lembrete agendado";
            const state = deadline(lead.next_follow_up, now);
            return <li key={lead.id} className={cn("flex items-start gap-2 rounded-lg border p-2", state.color)}>
              <label className="flex size-11 shrink-0 items-center justify-center cursor-pointer"><input type="checkbox" checked={false} disabled={busy || !!editor} aria-label={`Concluir: ${text}`} onChange={() => { void mutate(`/api/leads/${lead.id}/crm`, "PATCH", { next_follow_up: null }, "Lembrete concluído."); }} className="size-5 accent-cyan-500 focus-visible:outline-2 focus-visible:outline-ring" /></label>
              <div className="min-w-0 py-1 space-y-1"><p className="text-sm text-foreground whitespace-pre-wrap break-words">{text}</p><Link href={`/leads?openLeadId=${lead.id}`} className="text-xs text-cyan-300 hover:underline break-words">{lead.nome_negocio || `Lead #${lead.id}`}</Link><p className="text-xs text-muted-foreground"><time dateTime={lead.next_follow_up}>{fmtTime(lead.next_follow_up)}</time></p><p className="text-[11px] font-semibold">{state.label}</p></div>
            </li>;
          })}</ul>
        </section>}
        <p className="text-xs text-muted-foreground">Destaque 30 minutos antes do prazo. Atualização a cada 30s com esta aba visível. Sem alertas com o painel fechado.</p>
      </CardContent>
    </Card>
  );
}
