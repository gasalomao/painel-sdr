"use client";

import { useEffect, useState, useCallback } from "react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  Bot, Sparkles, Save, Loader2, AlertCircle, Check, Plus, Trash2,
  ChevronUp, ChevronDown, Wand2, Power, RefreshCw, ClipboardCheck,
  History, ArrowRight, Globe, Pencil,
} from "lucide-react";

/* ============================================================
   TYPES
============================================================ */
type AgentRef = { id: number; name: string; role: string | null };

type OrganizerState = {
  enabled: boolean;
  prompt: string;
  defaultPrompt: string;
  effectivePrompt: string;
  globalEnabled: boolean;
  lastRun: string | null;
  executionHour: number;
  model: string;
  provider: string;
  isAdmin: boolean;
  agents: AgentRef[];
};

type KanbanColumn = {
  id: string;
  status_key: string;
  label: string;
  color: string;
  order_index: number;
  is_system: boolean;
};

type Suggestion = {
  business_type: string;
  columns: Array<{ status_key: string; label: string; color: string; rationale?: string }>;
  organizer_prompt: string;
};

type AiModel = { id: string; name: string };

type HistoryItem = {
  id: number;
  remote_jid: string;
  nome_negocio: string | null;
  status_antigo: string;
  status_novo: string;
  razao: string | null;
  resumo: string | null;
  batch_id: string | null;
  created_at: string;
};

type RunItem = {
  id: number;
  batch_id: string | null;
  triggered_by: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  model: string | null;
  chats_analyzed: number;
  leads_moved: number;
  status: string;
  summary: string | null;
};

const DEFAULT_COLOR = "#6b7280";
const PRESET_COLORS = [
  "#3b82f6", "#06b6d4", "#10b981", "#22c55e", "#eab308",
  "#f97316", "#ef4444", "#a855f7", "#ec4899", "#6b7280",
];

export default function OrganizadorPage() {
  const [org, setOrg] = useState<OrganizerState | null>(null);
  const [columns, setColumns] = useState<KanbanColumn[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Prompt + enabled draft (local)
  const [promptDraft, setPromptDraft] = useState("");
  const [enabledDraft, setEnabledDraft] = useState(true);
  const [savingOrg, setSavingOrg] = useState(false);

  // Global toggle (só admin)
  const [savingGlobal, setSavingGlobal] = useState(false);
  // Modelo (só admin)
  const [models, setModels] = useState<AiModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [savingModel, setSavingModel] = useState(false);

  // Kanban
  const [newColLabel, setNewColLabel] = useState("");
  const [newColColor, setNewColColor] = useState(DEFAULT_COLOR);

  // IA Suggest
  const [suggestAgentId, setSuggestAgentId] = useState<number | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  // Edição manual da sugestão antes de aplicar
  const [editingSuggestion, setEditingSuggestion] = useState(false);

  // ============= LOAD =============
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [orgRes, kbRes, histRes] = await Promise.all([
        fetch("/api/organizer", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/kanban-columns", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/organizer/history?limit=30", { cache: "no-store" }).then((r) => r.json()),
      ]);
      if (orgRes.ok) {
        const o: OrganizerState = {
          enabled: orgRes.enabled,
          prompt: orgRes.prompt,
          defaultPrompt: orgRes.defaultPrompt,
          effectivePrompt: orgRes.effectivePrompt || orgRes.defaultPrompt || "",
          globalEnabled: orgRes.globalEnabled,
          lastRun: orgRes.lastRun,
          executionHour: orgRes.executionHour,
          model: orgRes.model || "gemini-2.5-flash",
          provider: orgRes.provider || "Gemini",
          isAdmin: !!orgRes.isAdmin,
          agents: orgRes.agents || [],
        };
        setOrg(o);
        setPromptDraft(orgRes.prompt || "");
        setEnabledDraft(orgRes.enabled);
        // Default: 1º agente do cliente pra sugestão
        if (o.agents.length > 0 && suggestAgentId === null) setSuggestAgentId(o.agents[0].id);
      }
      if (kbRes.ok) setColumns(kbRes.columns);
      if (histRes.ok) {
        setHistory(histRes.history || []);
        setRuns(histRes.runs || []);
      }
      // Modelos só pra admin
      if (orgRes.ok && orgRes.isAdmin) {
        setModelsLoading(true);
        try {
          const m = await fetch("/api/ai-models", { cache: "no-store" }).then((r) => r.json());
          if (m.success && Array.isArray(m.models)) setModels(m.models);
        } catch { /* ignore */ }
        finally { setModelsLoading(false); }
      }
    } catch (err: any) {
      setError(err?.message || "Falha ao carregar");
    } finally {
      setLoading(false);
    }
  }, [suggestAgentId]);

  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // ============= ACTIONS =============
  const saveGlobalToggle = async (enabled: boolean) => {
    if (!org) return;
    setSavingGlobal(true);
    setError(null);
    try {
      const r = await fetch("/api/organizer/global-toggle", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const d = await r.json();
      if (!d.ok) setError(d.error || "Falha");
      else { setInfo(enabled ? "Organizador ativado GLOBALMENTE" : "Organizador desativado globalmente"); setTimeout(() => setInfo(null), 3000); reload(); }
    } finally { setSavingGlobal(false); }
  };

  const saveModel = async (newModel: string) => {
    if (!org || newModel === org.model) return;
    setSavingModel(true);
    try {
      const r = await fetch("/api/organizer/model", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: newModel }),
      });
      const d = await r.json();
      if (!d.ok) setError(d.error);
      else { setInfo("Modelo atualizado: " + newModel); setTimeout(() => setInfo(null), 3000); reload(); }
    } finally { setSavingModel(false); }
  };

  const saveOrg = async () => {
    setSavingOrg(true);
    setError(null);
    try {
      const r = await fetch("/api/organizer", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: enabledDraft, prompt: promptDraft }),
      });
      const d = await r.json();
      if (!d.ok) setError(d.error);
      else { setInfo("Configuração do cliente salva"); setTimeout(() => setInfo(null), 2500); reload(); }
    } finally { setSavingOrg(false); }
  };

  // ============= KANBAN CRUD =============
  const addColumn = async () => {
    const label = newColLabel.trim();
    if (!label) return;
    const status_key = label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
    const r = await fetch("/api/kanban-columns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status_key, label, color: newColColor }),
    });
    const d = await r.json();
    if (!d.ok) { alert("Erro: " + d.error); return; }
    setNewColLabel(""); setNewColColor(DEFAULT_COLOR);
    reload();
  };

  const updateColumn = async (id: string, patch: Partial<KanbanColumn>) => {
    await fetch(`/api/kanban-columns/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  };

  const deleteColumn = async (col: KanbanColumn) => {
    if (col.is_system) { alert("Coluna de sistema não pode ser apagada"); return; }
    if (!confirm(`Apagar "${col.label}"? Leads com esse status não são apagados, mas ficam órfãos.`)) return;
    const r = await fetch(`/api/kanban-columns/${col.id}`, { method: "DELETE" });
    const d = await r.json();
    if (!d.ok) { alert("Erro: " + d.error); return; }
    reload();
  };

  const moveColumn = async (idx: number, direction: -1 | 1) => {
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= columns.length) return;
    const swap = [...columns];
    [swap[idx], swap[newIdx]] = [swap[newIdx], swap[idx]];
    const updates = swap.map((c, i) => ({ id: c.id, order_index: i }));
    setColumns(swap.map((c, i) => ({ ...c, order_index: i })));
    await fetch("/api/kanban-columns", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columns: updates }),
    });
  };

  // ============= IA SUGGEST =============
  const generateSuggestion = async () => {
    if (!suggestAgentId) { alert("Escolha um agente IA primeiro"); return; }
    setSuggesting(true);
    setError(null);
    setSuggestion(null);
    try {
      const r = await fetch("/api/organizer/suggest-kanban", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: suggestAgentId }),
      });
      const d = await r.json();
      if (!d.ok) setError(d.error);
      else setSuggestion(d.suggestion);
    } finally { setSuggesting(false); }
  };

  const applySuggestion = async () => {
    if (!suggestion) return;
    if (!confirm(
      `Aplicar sugestão?\n\n` +
      `• Apaga colunas atuais do Kanban (não-sistema)\n` +
      `• Cria ${suggestion.columns.length} novas\n` +
      `• Substitui o prompt do Organizador\n\n` +
      `Continuar?`
    )) return;

    setSuggesting(true);
    try {
      const toDelete = columns.filter((c) => !c.is_system);
      await Promise.all(toDelete.map((c) =>
        fetch(`/api/kanban-columns/${c.id}`, { method: "DELETE" })
      ));
      const systemCount = columns.filter((c) => c.is_system).length;
      for (let i = 0; i < suggestion.columns.length; i++) {
        const col = suggestion.columns[i];
        if (columns.some((c) => c.is_system && c.status_key === col.status_key)) continue;
        await fetch("/api/kanban-columns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status_key: col.status_key, label: col.label, color: col.color,
            order_index: systemCount + i,
          }),
        });
      }
      await fetch("/api/organizer", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: enabledDraft, prompt: suggestion.organizer_prompt }),
      });
      setSuggestion(null);
      setEditingSuggestion(false);
      setInfo("Sugestão aplicada — Kanban e prompt atualizados");
      setTimeout(() => setInfo(null), 4000);
      reload();
    } finally { setSuggesting(false); }
  };

  // Helpers pra editor de sugestão (in-place)
  const editSuggColumn = (idx: number, patch: Partial<Suggestion["columns"][number]>) => {
    if (!suggestion) return;
    const next = { ...suggestion, columns: suggestion.columns.map((c, i) => i === idx ? { ...c, ...patch } : c) };
    setSuggestion(next);
  };
  const removeSuggColumn = (idx: number) => {
    if (!suggestion) return;
    setSuggestion({ ...suggestion, columns: suggestion.columns.filter((_, i) => i !== idx) });
  };
  const addSuggColumn = () => {
    if (!suggestion) return;
    setSuggestion({
      ...suggestion,
      columns: [...suggestion.columns, { status_key: "novo_status", label: "Nova coluna", color: DEFAULT_COLOR }],
    });
  };

  const promptDirty = (org?.prompt || "") !== promptDraft || (org?.enabled ?? true) !== enabledDraft;

  return (
    <div className="flex flex-col h-[100dvh] bg-background overflow-hidden text-white">
      <Header />

      <main className="flex-1 overflow-y-auto w-full">
        <div className="max-w-6xl mx-auto p-4 sm:p-8 space-y-6">
          {/* Header */}
          <div>
            <h1 className="text-2xl font-black tracking-tight flex items-center gap-3">
              <Bot className="w-7 h-7 text-purple-400" /> Organizador IA
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              Tudo do Organizador num só lugar: status, prompt, kanban, histórico e sugestão automática pro seu nicho.
            </p>
          </div>

          {/* Feedback */}
          {error && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-200 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{error}</span>
            </div>
          )}
          {info && (
            <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 text-xs flex items-start gap-2">
              <ClipboardCheck className="w-4 h-4 shrink-0 mt-0.5" /> <span>{info}</span>
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
            </div>
          ) : (
            <>
              {/* ============= CARD ADMIN (global toggle + modelo) ============= */}
              {org?.isAdmin && (
                <section className="rounded-2xl border border-purple-500/40 bg-purple-500/[0.06] p-5 space-y-4">
                  <div className="flex items-center gap-2">
                    <Globe className="w-4 h-4 text-purple-300" />
                    <h2 className="text-sm font-bold text-purple-200">Controles globais (admin)</h2>
                  </div>

                  {/* Toggle global */}
                  <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-black/30">
                    <div>
                      <p className="text-xs font-bold">Organizador IA ativo (todo o sistema)</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {org.globalEnabled
                          ? `Roda 1×/dia às ${String(org.executionHour).padStart(2, "0")}h. Pra desligar pra todos, use esse toggle.`
                          : "Desligado globalmente — nenhum cliente recebe organização automática até religar."}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => saveGlobalToggle(!org.globalEnabled)}
                      disabled={savingGlobal}
                      className={cn("w-12 h-6 rounded-full p-1 transition shrink-0", org.globalEnabled ? "bg-purple-500" : "bg-white/10", savingGlobal && "opacity-50")}
                    >
                      <div className={cn("w-4 h-4 rounded-full bg-white transition-all", org.globalEnabled && "translate-x-6")} />
                    </button>
                  </div>

                  {/* Modelo IA */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-black uppercase tracking-widest text-purple-300">
                        Modelo de IA (compartilhado entre clientes)
                      </label>
                      {modelsLoading && <span className="text-[9px] text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> modelos…</span>}
                      {!modelsLoading && models.length > 0 && <span className="text-[9px] text-emerald-400">{models.length} modelos Gemini (ao vivo)</span>}
                    </div>
                    <select
                      value={org.model}
                      onChange={(e) => saveModel(e.target.value)}
                      disabled={savingModel}
                      className="w-full bg-black/40 border border-purple-500/20 h-11 rounded-xl text-sm px-3 font-mono disabled:opacity-50"
                    >
                      {org.model && !models.some((m) => m.id === org.model) && (
                        <option value={org.model}>{org.model} (salvo)</option>
                      )}
                      {models.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.id})</option>)}
                      {models.length === 0 && !modelsLoading && <option value={org.model}>{org.model}</option>}
                    </select>
                    <p className="text-[9px] text-muted-foreground italic">
                      Lista vinda direto da API do Gemini — modelos novos lançados pela Google aparecem aqui automaticamente sem deploy.
                    </p>
                  </div>
                </section>
              )}

              {/* ============= CARD CLIENTE (status + prompt + modelo readonly) ============= */}
              <section className="rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-cyan-500/[0.06] to-transparent p-5 space-y-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <h2 className="text-sm font-bold flex items-center gap-2 text-cyan-200">
                    <Sparkles className="w-4 h-4" /> Sua configuração
                  </h2>
                  <div className="flex items-center gap-2 text-[10px]">
                    <span className={cn(
                      "px-2 py-1 rounded font-black uppercase tracking-widest",
                      enabledDraft && org?.globalEnabled ? "bg-emerald-500/20 text-emerald-300" : "bg-amber-500/20 text-amber-300"
                    )}>
                      {!org?.globalEnabled ? "GLOBAL OFF" : !enabledDraft ? "Cliente OFF" : "Ativo"}
                    </span>
                  </div>
                </div>

                {/* Toggle por cliente */}
                <label className="flex items-center justify-between gap-3 p-3 rounded-lg bg-black/30 cursor-pointer">
                  <div>
                    <p className="text-xs font-bold">Rodar pra essa conta</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Liga/desliga o Organizador SOMENTE pra esta conta. O global precisa estar ativo também.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEnabledDraft(!enabledDraft)}
                    className={cn("w-12 h-6 rounded-full p-1 transition shrink-0", enabledDraft ? "bg-cyan-500" : "bg-white/10")}
                  >
                    <div className={cn("w-4 h-4 rounded-full bg-white transition-all", enabledDraft && "translate-x-6")} />
                  </button>
                </label>

                {/* Modelo (readonly pra cliente, info-only) */}
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase tracking-widest text-cyan-300">
                    Modelo de IA em uso {!org?.isAdmin && "(controlado pelo admin)"}
                  </label>
                  <div className="px-3 py-2.5 rounded-xl bg-black/30 border border-white/10 text-sm font-mono text-white/90 flex items-center justify-between">
                    <span>{org?.model}</span>
                    <span className="text-[9px] text-muted-foreground uppercase">{org?.isAdmin ? "altere no card admin acima" : "readonly"}</span>
                  </div>
                </div>

                {/* Prompt */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] font-black uppercase tracking-widest text-cyan-300">Prompt do Organizador</label>
                    <div className="flex gap-1">
                      {promptDraft && (
                        <button type="button" onClick={() => setPromptDraft("")} className="text-[10px] text-muted-foreground hover:text-red-400">
                          Limpar (usar padrão)
                        </button>
                      )}
                      {!promptDraft && org?.defaultPrompt && (
                        <button type="button" onClick={() => setPromptDraft(org.defaultPrompt)} className="text-[10px] text-cyan-300 hover:underline">
                          Carregar template padrão
                        </button>
                      )}
                    </div>
                  </div>
                  <Textarea
                    value={promptDraft}
                    onChange={(e) => setPromptDraft(e.target.value)}
                    placeholder="Vazio = usa o padrão global. Personalize aqui pra adaptar a IA ao seu negócio."
                    className="bg-black/40 border-white/10 h-44 text-xs font-mono"
                  />
                  <p className="text-[9px] text-muted-foreground italic">
                    Prompt em uso atualmente (efetivo): {org?.prompt ? "seu prompt customizado" : "padrão global"}
                  </p>
                </div>

                <div className="flex items-center justify-end gap-2">
                  {promptDirty && <span className="text-[10px] text-amber-300">Alterações não salvas</span>}
                  <Button onClick={saveOrg} disabled={savingOrg || !promptDirty} className={cn("text-xs gap-2", promptDirty ? "glow-primary" : "bg-white/5 text-muted-foreground")}>
                    {savingOrg ? <><Loader2 className="w-4 h-4 animate-spin" /> Salvando</> : <><Save className="w-4 h-4" /> Salvar</>}
                  </Button>
                </div>
              </section>

              {/* ============= KANBAN EDITOR ============= */}
              <section className="glass-card rounded-2xl border-white/10 bg-white/[0.02] p-5 space-y-4">
                <div>
                  <h2 className="text-sm font-bold">Colunas do Kanban</h2>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Edite nomes, cores e ordem. Coluna "sistema" não pode ser apagada.
                  </p>
                </div>

                <div className="space-y-1.5">
                  {columns.map((col, idx) => (
                    <div key={col.id} className="flex items-center gap-2 p-2 rounded-lg bg-black/30 border border-white/5">
                      <div className="flex flex-col">
                        <button type="button" onClick={() => moveColumn(idx, -1)} disabled={idx === 0} className="h-4 w-5 text-muted-foreground hover:text-white disabled:opacity-20 flex items-center justify-center"><ChevronUp className="w-3 h-3" /></button>
                        <button type="button" onClick={() => moveColumn(idx, 1)} disabled={idx === columns.length - 1} className="h-4 w-5 text-muted-foreground hover:text-white disabled:opacity-20 flex items-center justify-center"><ChevronDown className="w-3 h-3" /></button>
                      </div>
                      <input
                        type="color"
                        value={col.color || DEFAULT_COLOR}
                        onChange={(e) => {
                          const next = columns.map((c) => c.id === col.id ? { ...c, color: e.target.value } : c);
                          setColumns(next);
                        }}
                        onBlur={(e) => updateColumn(col.id, { color: e.target.value })}
                        className="w-8 h-8 rounded cursor-pointer bg-transparent border border-white/10"
                      />
                      <Input
                        defaultValue={col.label}
                        onBlur={(e) => { if (e.target.value.trim() !== col.label) updateColumn(col.id, { label: e.target.value.trim() }); }}
                        className="flex-1 bg-white/5 border-white/10 h-9 text-sm"
                      />
                      <code className="text-[10px] text-muted-foreground font-mono shrink-0 px-2 py-1 bg-black/40 rounded">{col.status_key}</code>
                      {col.is_system && <span className="text-[9px] uppercase font-black tracking-widest text-amber-300 bg-amber-500/10 border border-amber-500/20 px-2 py-1 rounded">sistema</span>}
                      <Button onClick={() => deleteColumn(col)} disabled={col.is_system} size="icon" variant="ghost" className="h-8 w-8 text-red-400 hover:bg-red-500/10 disabled:opacity-30"><Trash2 className="w-3.5 h-3.5" /></Button>
                    </div>
                  ))}
                </div>

                <div className="flex items-center gap-2 p-2 rounded-lg bg-cyan-500/5 border border-cyan-500/20">
                  <input type="color" value={newColColor} onChange={(e) => setNewColColor(e.target.value)} className="w-8 h-8 rounded cursor-pointer bg-transparent border border-white/10" />
                  <Input value={newColLabel} onChange={(e) => setNewColLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addColumn()} placeholder="Nova coluna (ex: Em negociação)" className="flex-1 bg-white/5 border-white/10 h-9 text-sm" />
                  <div className="flex gap-0.5">
                    {PRESET_COLORS.map((c) => (
                      <button key={c} type="button" onClick={() => setNewColColor(c)} className={cn("w-5 h-5 rounded border-2", newColColor === c ? "border-white" : "border-transparent")} style={{ background: c }} />
                    ))}
                  </div>
                  <Button onClick={addColumn} disabled={!newColLabel.trim()} className="text-xs gap-1"><Plus className="w-3 h-3" /> Adicionar</Button>
                </div>
              </section>

              {/* ============= IA SUGGEST ============= */}
              <section className="glass-card rounded-2xl border-purple-500/30 bg-gradient-to-br from-purple-500/[0.04] to-transparent p-5 space-y-4">
                <div>
                  <h2 className="text-sm font-bold flex items-center gap-2">
                    <Wand2 className="w-4 h-4 text-purple-400" /> Sugestão automática (IA)
                  </h2>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    A IA lê o agente escolhido (prompt, função, base de conhecimento) e sugere um Kanban + prompt adequados ao seu nicho.
                  </p>
                </div>

                {/* Seletor de agente */}
                {!suggestion && (
                  <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-purple-300">
                      Agente IA pra analisar
                    </label>
                    {org?.agents.length === 0 ? (
                      <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-200 text-[11px]">
                        Nenhum agente IA cadastrado pra essa conta. Crie um em <code>/agente</code> antes de pedir sugestão.
                      </div>
                    ) : (
                      <select
                        value={suggestAgentId || ""}
                        onChange={(e) => setSuggestAgentId(Number(e.target.value) || null)}
                        className="w-full bg-black/40 border border-purple-500/20 h-11 rounded-xl text-sm px-3"
                      >
                        {org?.agents.map((a) => (
                          <option key={a.id} value={a.id} className="bg-neutral-900">
                            #{a.id} · {a.name}{a.role ? ` — ${a.role.slice(0, 50)}` : ""}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )}

                {!suggestion && (
                  <Button onClick={generateSuggestion} disabled={suggesting || !suggestAgentId} className="bg-purple-600 hover:bg-purple-500 text-white text-xs gap-2">
                    {suggesting ? <><Loader2 className="w-4 h-4 animate-spin" /> Analisando agente…</> : <><Sparkles className="w-4 h-4" /> Gerar sugestão</>}
                  </Button>
                )}

                {suggestion && (
                  <div className="space-y-4">
                    {/* Negócio identificado */}
                    <div className="p-3 rounded-xl bg-black/30 border border-purple-500/20">
                      <p className="text-[10px] uppercase font-black tracking-widest text-purple-300">Negócio identificado</p>
                      <p className="text-sm text-white mt-1">{suggestion.business_type}</p>
                    </div>

                    {/* Colunas com edição inline */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[10px] uppercase font-black tracking-widest text-purple-300">
                          Colunas sugeridas ({suggestion.columns.length})
                        </p>
                        <button onClick={() => setEditingSuggestion(!editingSuggestion)} className="text-[10px] text-purple-300 hover:underline flex items-center gap-1">
                          <Pencil className="w-3 h-3" /> {editingSuggestion ? "Concluir edição" : "Editar antes de aplicar"}
                        </button>
                      </div>
                      <div className="space-y-1.5">
                        {suggestion.columns.map((c, i) => (
                          <div key={i} className="flex items-center gap-2 p-2 rounded bg-black/20 border border-white/5">
                            {editingSuggestion ? (
                              <>
                                <input type="color" value={c.color} onChange={(e) => editSuggColumn(i, { color: e.target.value })} className="w-7 h-7 rounded bg-transparent border border-white/10 cursor-pointer" />
                                <Input value={c.label} onChange={(e) => editSuggColumn(i, { label: e.target.value })} className="flex-1 bg-white/5 border-white/10 h-8 text-xs" />
                                <Input value={c.status_key} onChange={(e) => editSuggColumn(i, { status_key: e.target.value })} className="w-32 bg-black/40 border-white/10 h-8 text-[10px] font-mono" />
                                <Button onClick={() => removeSuggColumn(i)} size="icon" variant="ghost" className="h-7 w-7 text-red-400 hover:bg-red-500/10"><Trash2 className="w-3 h-3" /></Button>
                              </>
                            ) : (
                              <>
                                <div className="w-4 h-4 rounded shrink-0" style={{ background: c.color }} />
                                <span className="text-sm font-bold">{c.label}</span>
                                <code className="text-[9px] text-muted-foreground font-mono">{c.status_key}</code>
                                {c.rationale && <span className="text-[10px] text-muted-foreground ml-auto truncate max-w-[40%]" title={c.rationale}>{c.rationale}</span>}
                              </>
                            )}
                          </div>
                        ))}
                        {editingSuggestion && (
                          <button onClick={addSuggColumn} className="w-full p-2 rounded bg-white/5 border border-dashed border-white/20 text-xs text-muted-foreground hover:text-white hover:bg-white/10 flex items-center justify-center gap-1">
                            <Plus className="w-3 h-3" /> Adicionar coluna
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Prompt sugerido (editável) */}
                    <div>
                      <p className="text-[10px] uppercase font-black tracking-widest text-purple-300 mb-2">Prompt sugerido (editável)</p>
                      <Textarea
                        value={suggestion.organizer_prompt}
                        onChange={(e) => setSuggestion({ ...suggestion, organizer_prompt: e.target.value })}
                        className="bg-black/40 border-white/10 h-44 text-xs font-mono"
                      />
                    </div>

                    <div className="flex justify-end gap-2 pt-2 border-t border-purple-500/10">
                      <Button onClick={() => { setSuggestion(null); setEditingSuggestion(false); }} variant="outline" className="text-xs">
                        Descartar
                      </Button>
                      <Button onClick={generateSuggestion} disabled={suggesting} variant="outline" className="text-xs gap-1">
                        <RefreshCw className="w-3 h-3" /> Gerar outra
                      </Button>
                      <Button onClick={applySuggestion} disabled={suggesting} className="bg-purple-600 hover:bg-purple-500 text-xs gap-1">
                        {suggesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Aceitar e aplicar
                      </Button>
                    </div>
                  </div>
                )}
              </section>

              {/* ============= HISTÓRICO ============= */}
              <section className="glass-card rounded-2xl border-white/10 bg-white/[0.02] p-5 space-y-4">
                <div>
                  <h2 className="text-sm font-bold flex items-center gap-2">
                    <History className="w-4 h-4" /> Histórico
                  </h2>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Últimas execuções do Organizador + movimentações de leads que ele fez.
                  </p>
                </div>

                {/* Runs */}
                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase font-black tracking-widest text-muted-foreground">Últimas execuções</p>
                  {runs.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground italic">Nenhuma execução registrada ainda.</p>
                  ) : (
                    <div className="space-y-1">
                      {runs.slice(0, 8).map((r) => (
                        <div key={r.id} className="flex items-center gap-2 p-2 rounded bg-black/20 border border-white/5 text-[11px]">
                          <span className={cn("w-2 h-2 rounded-full shrink-0",
                            r.status === "ok" ? "bg-emerald-500" :
                            r.status === "error" ? "bg-red-500" :
                            r.status === "noop" ? "bg-white/30" : "bg-amber-500"
                          )} />
                          <span className="text-white/80 shrink-0 w-32 truncate">{new Date(r.started_at).toLocaleString("pt-BR")}</span>
                          <span className="text-muted-foreground shrink-0">{r.triggered_by}</span>
                          <span className="text-cyan-300 shrink-0">{r.chats_analyzed} chats</span>
                          <span className="text-emerald-300 shrink-0">{r.leads_moved} movidos</span>
                          <span className="text-muted-foreground truncate flex-1 min-w-0">{r.summary || ""}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Movimentações */}
                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase font-black tracking-widest text-muted-foreground">Últimas movimentações de leads</p>
                  {history.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground italic">Nenhuma movimentação ainda.</p>
                  ) : (
                    <div className="space-y-1">
                      {history.slice(0, 15).map((h) => {
                        const moved = h.status_antigo !== h.status_novo;
                        return (
                          <div key={h.id} className="flex items-start gap-2 p-2 rounded bg-black/20 border border-white/5 text-[11px]">
                            <span className={cn("shrink-0 px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-widest",
                              moved ? "bg-purple-500/20 text-purple-200" : "bg-white/5 text-muted-foreground"
                            )}>
                              {moved ? "MOVIDO" : "Mantido"}
                            </span>
                            <span className="text-white/80 shrink-0 max-w-[140px] truncate">{h.nome_negocio || h.remote_jid}</span>
                            <div className="flex items-center gap-1 shrink-0 text-[10px] font-mono">
                              <code className="px-1 bg-black/40 rounded text-muted-foreground">{h.status_antigo}</code>
                              <ArrowRight className="w-2.5 h-2.5 text-muted-foreground" />
                              <code className={cn("px-1 rounded", moved ? "bg-purple-500/20 text-purple-200" : "bg-black/40 text-muted-foreground")}>{h.status_novo}</code>
                            </div>
                            <span className="text-muted-foreground italic truncate flex-1 min-w-0" title={h.razao || ""}>{h.razao}</span>
                            <span className="text-muted-foreground/60 shrink-0 text-[9px]">{new Date(h.created_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
