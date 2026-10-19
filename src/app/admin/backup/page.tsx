"use client";

import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { Database, HardDrive, Loader2 } from "lucide-react";
import { useClientSession } from "@/lib/use-session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { BackupDiagnosticsPanel } from "@/components/backup-diagnostics-panel";

interface Config {
  enabled: boolean; interval_hours: number; retention_days: number; connected: boolean;
  google_drive_folder_id: string | null; last_backup_at: string | null;
  last_backup_status: string | null; last_backup_error: string | null; next_backup_at: string | null;
}
interface Run { id: string; status: string; stage: string; error_message: string | null; heartbeat_at?: string }
interface Event { id: number; message: string; level: string; created_at: string }
interface History { id: number; drive_file_id: string; drive_file_name: string; file_size_bytes: number; status: string; created_at: string }
interface Payload { success: boolean; error?: string; config?: Config; activeRun?: Run; latestRun?: Run; workerEnabled?: boolean; backups?: History[]; runId?: string; run?: Run; events?: Event[]; authUrl?: string }

async function request(path: string, options?: RequestInit): Promise<Payload> {
  const response = await fetch(path, { cache: "no-store", ...options });
  const data = await response.json() as Payload;
  if (!response.ok || !data.success) throw new Error(data.error || "Solicitação não concluída.");
  return data;
}
const date = (value: string | null): string => value ? new Date(value).toLocaleString("pt-BR") : "Nenhum";

export default function BackupAdminPage() {
  const { session, loading: sessionLoading } = useClientSession();
  const isAdmin = Boolean(session?.isAdmin && !session?.impersonating);
  const [config, setConfig] = useState<Config | null>(null);
  const [draft, setDraft] = useState({ enabled: false, interval_hours: 24, retention_days: 7 });
  const [history, setHistory] = useState<History[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [workerEnabled, setWorkerEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (signal?: AbortSignal, resetDraft = false) => {
    const [settings, items] = await Promise.all([request("/api/backup/config", { signal }), request("/api/backup/history", { signal })]);
    if (signal?.aborted) return;
    if (settings.config) {
      setConfig(settings.config);
      if (resetDraft) setDraft({ enabled: settings.config.enabled, interval_hours: settings.config.interval_hours, retention_days: settings.config.retention_days });
    }
    setWorkerEnabled(Boolean(settings.workerEnabled));
    setHistory(items.backups || []);
    setRun(settings.activeRun || settings.latestRun || null);
  }, []);

  useEffect(() => {
    if (sessionLoading) return;
    if (!isAdmin) { setIsLoading(false); return; }
    const controller = new AbortController();
    void reload(controller.signal, true).catch(e => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Erro ao carregar configuração.");
    }).finally(() => { if (!controller.signal.aborted) setIsLoading(false); });
    return () => controller.abort();
  }, [sessionLoading, isAdmin, reload]);

  const active = run?.status === "queued" || run?.status === "running";
  const runId = run?.id;
  const isRunActive = useEffectEvent(() => active);
  useEffect(() => {
    if (!runId || !isAdmin) return;
    setEvents([]);
    const controller = new AbortController();
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await request(`/api/backup/progress?run_id=${encodeURIComponent(runId)}&after=${cursor}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const incoming = data.events || [];
        if (incoming.length) {
          cursor = incoming[incoming.length - 1].id;
          setEvents(previous => [...previous, ...incoming.filter(item => !previous.some(existing => existing.id === item.id))]);
        }
        if (data.run) setRun(data.run);
        if (data.run?.status === "success" || data.run?.status === "failed") {
          if (incoming.length === 200) { await poll(); return; }
          await reload(controller.signal);
          return;
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Não foi possível atualizar o progresso.");
        if (!isRunActive()) return;
      }
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 2000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [runId, isAdmin, reload]);

  const action = async (task: () => Promise<void>) => {
    setIsBusy(true); setError(null);
    try { await task(); } catch (e) { setError(e instanceof Error ? e.message : "Operação falhou."); }
    finally { setIsBusy(false); }
  };
  const dirty = config && (draft.enabled !== config.enabled || draft.interval_hours !== config.interval_hours || draft.retention_days !== config.retention_days);
  const section = "rounded-xl border border-border bg-card p-5 sm:p-6 space-y-4";

  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain bg-background text-foreground" role="region" aria-label="Painel de backup" tabIndex={0}>
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 pb-24 sm:px-6">
        <a href="/configuracoes" className="text-sm text-muted-foreground underline">Voltar às configurações</a>
        <header className="space-y-2">
          <h1 className="flex items-center gap-3 text-2xl sm:text-3xl font-bold"><Database aria-hidden="true" /> Proteção do banco de dados</h1>
          <p className="text-muted-foreground">Snapshots completos do PostgreSQL remoto, organizados no Google Drive.</p>
        </header>
        {error && <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-red-300 break-words">{error}</div>}
        {(sessionLoading || isLoading) ? <p role="status" className="flex items-center gap-2"><Loader2 className="animate-spin" aria-hidden="true" /> Carregando backup…</p> : !isAdmin ? <p role="alert">Acesso restrito ao administrador, fora do modo de personificação.</p> : <>
          <section className={section} aria-labelledby="drive-heading">
            <h2 id="drive-heading" className="flex gap-2 text-lg font-semibold"><HardDrive aria-hidden="true" /> Google Drive</h2>
            <p className={config?.connected ? "text-emerald-400" : "text-amber-300"}>{config?.connected ? "Conta conectada — isso não comprova que existe um backup válido." : "Conta ainda não conectada."}</p>
            {config?.google_drive_folder_id && <a className="underline" target="_blank" rel="noopener noreferrer" href={`https://drive.google.com/drive/folders/${encodeURIComponent(config.google_drive_folder_id)}`}>Abrir pasta de backups</a>}
            <Button disabled={isBusy} onClick={() => void action(async () => {
              const data = await request("/api/backup/google/auth");
              const url = new URL(data.authUrl || "");
              if (url.protocol !== "https:" || url.hostname !== "accounts.google.com") throw new Error("URL de autorização inválida.");
              window.location.assign(url.href);
            })}>{config?.connected ? "Reconectar Google Drive" : "Conectar Google Drive"}</Button>
          </section>
          <section className={section} aria-labelledby="schedule-heading">
            <h2 id="schedule-heading" className="text-lg font-semibold">Agenda e retenção</h2>
            <p className={config?.enabled ? "font-bold text-emerald-400" : "font-bold text-amber-300"}>Estado salvo: {config?.enabled ? "ATIVADO" : "DESATIVADO"}</p>
            {!workerEnabled && <p role="status" className="text-amber-300">Worker desativado no servidor. Agenda e backup manual não serão executados.</p>}
            <div className="flex items-center justify-between gap-4"><label htmlFor="enabled">Habilitar backup automático</label><Switch id="enabled" checked={draft.enabled} onCheckedChange={enabled => setDraft(previous => ({ ...previous, enabled }))} /></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div><label htmlFor="interval">Intervalo entre cópias (horas)</label><Input id="interval" type="number" min={1} max={8760} value={draft.interval_hours} onChange={e => setDraft(previous => ({ ...previous, interval_hours: Number(e.target.value) }))} /></div>
              <div><label htmlFor="retention">Manter cópias por (dias)</label><Input id="retention" type="number" min={1} max={3650} value={draft.retention_days} onChange={e => setDraft(previous => ({ ...previous, retention_days: Number(e.target.value) }))} /></div>
            </div>
            <p className="text-sm text-muted-foreground">Cópias vencidas do próprio sistema são apagadas somente após uma nova cópia conferida. A última cópia é preservada.</p>
            {dirty && <p role="status" className="text-amber-300">Alterações ainda não salvas.</p>}
            <Button disabled={isBusy || !config} onClick={() => void action(async () => {
              const data = await request("/api/backup/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
              if (data.config) setConfig(data.config);
            })}>Salvar configuração</Button>
            <dl className="grid gap-2 text-sm"><div>Próxima execução: {config?.enabled ? date(config.next_backup_at) : "Agenda desativada"}</div><div>Última cópia enviada: {date(config?.last_backup_at || null)}</div></dl>
            {config?.last_backup_error && <p role="alert" className="text-red-300">{config.last_backup_error}</p>}
          </section>
          <section className={section} aria-labelledby="progress-heading">
            <h2 id="progress-heading" className="text-lg font-semibold">Execução e progresso real</h2>
            <BackupDiagnosticsPanel disabled={isBusy || active} />
            {run?.error_message && <p role="alert" className="break-words text-sm text-red-300">{run.error_message}</p>}
            {error && error !== run?.error_message && <p role="alert" className="break-words text-sm text-red-300">{error}</p>}
            <Button disabled={isBusy || active || !workerEnabled || !config?.connected} onClick={() => void action(async () => {
              const data = await request("/api/backup/create", { method: "POST" });
              if (!data.runId) throw new Error("Servidor não confirmou o agendamento.");
              setEvents([]); setRun({ id: data.runId, status: "queued", stage: "queued", error_message: null });
            })}>{active ? "Backup em andamento" : "Criar backup agora"}</Button>
            {run && <p role="status">Execução: {run.status} · Etapa: {run.stage}</p>}
            <div role="log" aria-label="Eventos reais do backup" aria-live="polite" className="max-h-80 overflow-y-auto rounded-lg bg-muted p-4 text-xs font-mono break-words space-y-2">
              {!events.length && <p className="text-muted-foreground">Nenhum evento recebido. Não há etapas simuladas.</p>}
              {events.map(item => <p key={item.id} className={item.level === "error" ? "text-red-300" : ""}>{date(item.created_at)} · {item.message}</p>)}
            </div>
          </section>
          <section className={section} aria-labelledby="history-heading">
            <h2 id="history-heading" className="text-lg font-semibold">Histórico</h2>
            <Button variant="outline" disabled={isBusy} onClick={() => void action(() => reload())}>Atualizar histórico</Button>
            {!history.length && <p>Nenhuma cópia registrada.</p>}
            {history.map(item => <article key={item.id} className="border-t border-border pt-4 space-y-1 break-words">
              <h3 className="font-medium">{item.drive_file_name}</h3><p className="text-sm text-muted-foreground">{date(item.created_at)} · {(item.file_size_bytes / 1048576).toFixed(2)} MB · {item.status === "success" ? "Enviado — restauração ainda não comprovada" : item.status === "failed" ? "Falhou (mensagem antiga ocultada por segurança)" : item.status}</p>
              {item.status === "success" && item.drive_file_id && <a className="underline text-sm" target="_blank" rel="noopener noreferrer" href={`https://drive.google.com/file/d/${encodeURIComponent(item.drive_file_id)}/view`}>Abrir / baixar arquivo no Drive</a>}
            </article>)}
          </section>
          <aside className="rounded-xl border border-amber-500/30 p-5 space-y-2 text-sm">
            <h2 className="font-bold">O que esta cópia protege</h2>
            <p>Todos os schemas/tabelas do snapshot, dados, funções, triggers, políticas, permissões e roles sem senhas. Novas tabelas entram automaticamente na próxima cópia.</p>
            <p>Não inclui arquivos físicos do Storage, volumes da VPS, .env ou serviços externos. Alterações posteriores ao snapshot não estarão nessa cópia.</p>
            <p>Recuperação deve ser testada em outro Supabase compatível. Restaurar sobre o banco atual foi bloqueado para evitar perda de dados.</p>
          </aside>
        </>}
      </div>
    </div>
  );
}
