"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { DashboardTask } from "@/types/dashboard-tasks";

interface TaskInput {
  text: string;
  due_at: string;
  lead_id: number | null;
}

interface LeadOption { id: number; nome_negocio: string }

function localDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function DashboardTaskForm({ task, busy, onSave, onCancel }: {
  task: DashboardTask | null;
  busy: boolean;
  onSave: (input: TaskInput) => Promise<void>;
  onCancel: () => void;
}): React.JSX.Element {
  const id = useId();
  const [text, setText] = useState(task?.text ?? "");
  const [dueAt, setDueAt] = useState(localDate(task?.due_at));
  const [leadId, setLeadId] = useState(task?.lead_id?.toString() ?? "");
  const [query, setQuery] = useState("");
  const [leads, setLeads] = useState<LeadOption[]>([]);
  const [chosenLead, setChosenLead] = useState<LeadOption | null>(task?.lead_id ? { id: task.lead_id, nome_negocio: task.lead_name || `Lead #${task.lead_id}` } : null);
  const [error, setError] = useState("");
  const [searchError, setSearchError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLeads([]);
    setSearchError("");
    if (query.trim().length < 2) return () => controller.abort();
    const timeout = setTimeout(async () => {
      try {
        const res = await fetch(`/api/tasks/leads?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Falha ao buscar leads");
        if (!controller.signal.aborted) setLeads(data.leads);
      } catch {
        if (!controller.signal.aborted) setSearchError("Não foi possível buscar leads. Tente novamente.");
      }
    }, 300);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [query]);

  const options = [...leads];
  if (chosenLead && !options.some(l => l.id === chosenLead.id)) options.unshift(chosenLead);

  return (
    <form className="space-y-3 rounded-lg border border-border bg-muted/20 p-3" onSubmit={async e => {
      e.preventDefault();
      if (busy) return;
      if (!text.trim() || !dueAt || !Number.isFinite(new Date(dueAt).getTime())) {
        setError("Escreva a tarefa e informe uma data e horário válidos.");
        return;
      }
      setError("");
      await onSave({ text: text.trim(), due_at: new Date(dueAt).toISOString(), lead_id: leadId ? Number(leadId) : null });
    }}>
      <p className="text-sm font-semibold">{task ? "Editar tarefa" : "Nova tarefa"}</p>
      <fieldset disabled={busy} className="space-y-3 min-w-0">
        <div className="space-y-1">
          <label htmlFor={`${id}-text`} className="text-xs font-medium">O que precisa fazer?</label>
          <Textarea id={`${id}-text`} required maxLength={1000} rows={3} value={text} onChange={e => setText(e.target.value)} autoFocus placeholder="Ex.: entregar projeto X" aria-describedby={error ? `${id}-error` : undefined} aria-invalid={error ? !text.trim() : undefined} />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-date`} className="text-xs font-medium">Data e horário</label>
          <Input id={`${id}-date`} type="datetime-local" required value={dueAt} onChange={e => setDueAt(e.target.value)} className="min-w-0" aria-describedby={error ? `${id}-error` : undefined} aria-invalid={error ? !dueAt : undefined} />
          <p className="text-xs text-muted-foreground">Horário local do seu dispositivo.</p>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-search`} className="text-xs font-medium">Buscar lead (opcional)</label>
          <Input id={`${id}-search`} type="search" maxLength={100} value={query} onChange={e => setQuery(e.target.value)} placeholder="Digite pelo menos 2 letras" aria-describedby={searchError ? `${id}-search-error` : undefined} />
          {searchError && <p id={`${id}-search-error`} role="alert" className="text-xs text-destructive">{searchError}</p>}
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-lead`} className="text-xs font-medium">Vincular a um lead</label>
          <select id={`${id}-lead`} value={leadId} onChange={e => { setLeadId(e.target.value); setChosenLead(options.find(l => String(l.id) === e.target.value) || null); }} className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring">
            <option value="">Sem lead — tarefa livre</option>
            {options.map(lead => <option key={lead.id} value={lead.id}>{lead.nome_negocio || `Lead #${lead.id}`}</option>)}
          </select>
        </div>
        {error && <p id={`${id}-error`} role="alert" className="text-xs text-destructive">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm">{busy ? "Salvando…" : "Salvar tarefa"}</Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancelar</Button>
        </div>
      </fieldset>
    </form>
  );
}
