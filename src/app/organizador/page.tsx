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
  History, ArrowRight, Globe, Pencil, Search, FileText, Eye, EyeOff,
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

  // Prompt + enabled + hour draft (local)
  const [promptDraft, setPromptDraft] = useState("");
  const [enabledDraft, setEnabledDraft] = useState(true);
  const [hourDraft, setHourDraft] = useState<number>(20);
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

  // Histórico: busca + linha expandida
  const [historyQuery, setHistoryQuery] = useState("");
  const [expandedHistoryId, setExpandedHistoryId] = useState<number | null>(null);
  const [clearingHistory, setClearingHistory] = useState(false);

  // Prompt EFETIVO completo (o que de fato vai pra IA)
  const [effective, setEffective] = useState<{
    fullPrompt: string;
    customPrompt: string | null;
    defaultBasePrompt: string;
    kanbanAppendix: string;
    dateContext: string;
  } | null>(null);
  const [effectiveVisible, setEffectiveVisible] = useState(false);
  const [editingDefault, setEditingDefault] = useState(false);
  const [defaultDraft, setDefaultDraft] = useState("");
  // Sugestão de prompt pelo /api/organizer/suggest-prompt — preview antes de aplicar
  const [promptSuggesting, setPromptSuggesting] = useState(false);
  const [promptSuggestion, setPromptSuggestion] = useState<{ business_type: string; organizer_prompt: string } | null>(null);

  // Disparo manual ("Rodar agora") — só pra essa conta
  const [runningNow, setRunningNow] = useState(false);

  // ============= LOAD =============
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [orgRes, kbRes, histRes, effRes] = await Promise.all([
        fetch("/api/organizer", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/kanban-columns", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/organizer/history?limit=100", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/organizer/effective-prompt", { cache: "no-store" }).then((r) => r.json()),
      ]);
      if (effRes?.ok) {
        setEffective({
          fullPrompt: effRes.fullPrompt,
          customPrompt: effRes.customPrompt,
          defaultBasePrompt: effRes.defaultBasePrompt,
          kanbanAppendix: effRes.kanbanAppendix,
          dateContext: effRes.dateContext,
        });
        setDefaultDraft(effRes.defaultBasePrompt);
      }
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
        setHourDraft(typeof orgRes.executionHour === "number" ? orgRes.executionHour : 20);
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
        body: JSON.stringify({ enabled: enabledDraft, prompt: promptDraft, executionHour: hourDraft }),
      });
      const d = await r.json();
      if (!d.ok) setError(d.error);
      else { setInfo("Configuração do cliente salva"); setTimeout(() => setInfo(null), 2500); reload(); }
    } finally { setSavingOrg(false); }
  };

  // ============= HISTÓRICO: delete =============
  const deleteHistoryItem = async (id: number) => {
    if (!confirm("Apagar essa movimentação do histórico? O lead em si NÃO é afetado.")) return;
    const r = await fetch(`/api/organizer/history?id=${id}`, { method: "DELETE" });
    const d = await r.json();
    if (!d.ok) { alert("Erro: " + d.error); return; }
    setHistory((prev) => prev.filter((h) => h.id !== id));
  };
  const clearAllHistory = async () => {
    if (!confirm("Limpar TODO o histórico do organizador? Os leads NÃO são afetados — só o log de movimentações.")) return;
    setClearingHistory(true);
    try {
      const r = await fetch("/api/organizer/history", { method: "DELETE" });
      const d = await r.json();
      if (!d.ok) { alert("Erro: " + d.error); return; }
      setHistory([]);
      setInfo("Histórico apagado"); setTimeout(() => setInfo(null), 2500);
    } finally { setClearingHistory(false); }
  };

  const filteredHistory = history.filter((h) => {
    if (!historyQuery.trim()) return true;
    const q = historyQuery.toLowerCase();
    return (h.nome_negocio || "").toLowerCase().includes(q)
      || (h.remote_jid || "").toLowerCase().includes(q)
      || (h.status_antigo || "").toLowerCase().includes(q)
      || (h.status_novo || "").toLowerCase().includes(q)
      || (h.razao || "").toLowerCase().includes(q)
      || (h.resumo || "").toLowerCase().includes(q);
  });

  // ============= SUGESTÃO DE PROMPT (kanban atual + agente) =============
  const generatePromptSuggestion = async () => {
    setPromptSuggesting(true);
    setError(null);
    try {
      const r = await fetch("/api/organizer/suggest-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: suggestAgentId || undefined }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error); return; }
      setPromptSuggestion(d.suggestion);
    } finally { setPromptSuggesting(false); }
  };
  const runNow = async () => {
    if (!confirm("Rodar o Organizador AGORA pra esta conta? Vai analisar as conversas de hoje e mover leads no kanban se preciso.")) return;
    setRunningNow(true);
    setError(null);
    try {
      const r = await fetch("/api/organizer/run-now", { method: "POST", credentials: "include" });
      const d = await r.json();
      if (!d.ok) { setError(d.error || "Falha"); return; }
      setInfo(`✓ Execução concluída — ${d.updatedCount || 0} lead(s) movido(s). Atualizando histórico…`);
      setTimeout(() => setInfo(null), 5000);
      reload();
    } catch (e: any) {
      setError(e?.message || "Falha de rede");
    } finally { setRunningNow(false); }
  };

  const applyPromptSuggestion = async () => {
    if (!promptSuggestion) return;
    setSavingOrg(true);
    try {
      const r = await fetch("/api/organizer", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: enabledDraft, prompt: promptSuggestion.organizer_prompt, executionHour: hourDraft }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error); return; }
      setPromptDraft(promptSuggestion.organizer_prompt);
      setPromptSuggestion(null);
      setInfo("Prompt sugerido aplicado e salvo");
      setTimeout(() => setInfo(null), 3000);
      reload();
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

  const promptDirty = (org?.prompt || "") !== promptDraft
    || (org?.enabled ?? true) !== enabledDraft
    || (org?.executionHour ?? 20) !== hourDraft;

  return (
    <div className="flex flex-col h-[100dvh] bg-background overflow-hidden text-white">
      <Header />

      <main className="flex-1 overflow-y-auto w-full">
        <div className="max-w-6xl mx-auto p-4 sm:p-8 space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-2xl font-black tracking-tight flex items-center gap-3">
                <Bot className="w-7 h-7 text-purple-400" /> Organizador IA
              </h1>
              <p className="text-xs text-muted-foreground mt-1">
                Tudo do Organizador num só lugar: status, prompt, kanban, histórico e sugestão automática pro seu nicho.
              </p>
            </div>
            <Button
              onClick={runNow}
              disabled={runningNow || loading || !org?.globalEnabled || !enabledDraft}
              title={!org?.globalEnabled ? "Organizador desligado globalmente" : !enabledDraft ? "Ativo desligado pra essa conta" : "Roda agora analisando as conversas de hoje desta conta"}
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm gap-2 h-11 px-4 shrink-0"
            >
              {runningNow ? <><Loader2 className="w-4 h-4 animate-spin" /> Executando…</> : <><Power className="w-4 h-4" /> Rodar agora</>}
            </Button>
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
                          ? "Kill-switch global. Cada cliente escolhe a própria hora (configurada no card abaixo). Aqui só liga/desliga o sistema todo."
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
              <section className="rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-cyan-500/[0.06] to-transparent p-5 space-y-5">
                {/* ----- INTRO DIDÁTICO ----- */}
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <h2 className="text-base font-bold flex items-center gap-2 text-cyan-200">
                      <Sparkles className="w-5 h-5" /> Sua configuração
                    </h2>
                    <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed max-w-2xl">
                      Aqui você decide <strong className="text-white">quando</strong> a IA analisa suas conversas e <strong className="text-white">como</strong> ela decide pra qual coluna do Kanban cada lead vai. É pessoal — só afeta esta conta.
                    </p>
                  </div>
                  <span className={cn(
                    "px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest",
                    enabledDraft && org?.globalEnabled ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                  )}>
                    {!org?.globalEnabled ? "Sistema desligado" : !enabledDraft ? "Sua conta: pausada" : "✓ Funcionando"}
                  </span>
                </div>

                {/* ----- 1. ATIVAÇÃO ----- */}
                <div className="rounded-xl bg-black/30 p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-cyan-500/20 text-cyan-300 text-[11px] font-black flex items-center justify-center">1</span>
                    <p className="text-xs font-bold text-white">Ligar o Organizador</p>
                  </div>
                  <label className="flex items-center justify-between gap-3 cursor-pointer pl-8">
                    <p className="text-[11px] text-muted-foreground">
                      Quando ligado, a IA analisa as conversas <strong className="text-white">automaticamente todo dia</strong>. Desligue se quiser parar de mexer nos leads dessa conta.
                    </p>
                    <button
                      type="button"
                      onClick={() => setEnabledDraft(!enabledDraft)}
                      className={cn("w-14 h-7 rounded-full p-1 transition shrink-0", enabledDraft ? "bg-cyan-500" : "bg-white/10")}
                    >
                      <div className={cn("w-5 h-5 rounded-full bg-white transition-all", enabledDraft && "translate-x-7")} />
                    </button>
                  </label>
                </div>

                {/* ----- 2. HORÁRIO ----- */}
                <div className="rounded-xl bg-black/30 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-cyan-500/20 text-cyan-300 text-[11px] font-black flex items-center justify-center">2</span>
                    <p className="text-xs font-bold text-white">Que horas rodar</p>
                  </div>
                  <div className="pl-8 space-y-2">
                    <p className="text-[11px] text-muted-foreground">
                      A IA roda <strong className="text-white">uma vez por dia</strong> no horário que você escolher. A dica é deixar pra um horário em que você já parou de atender (ex.: noite), pra ela analisar tudo de uma vez.
                    </p>
                    <div className="flex items-center gap-3 flex-wrap">
                      <select
                        value={hourDraft}
                        onChange={(e) => setHourDraft(Number(e.target.value))}
                        className="bg-black/40 border border-cyan-500/20 text-white h-11 rounded-xl text-base font-bold px-4 focus:outline-none focus:border-cyan-400"
                      >
                        {Array.from({ length: 24 }, (_, h) => (
                          <option key={h} value={h} className="bg-neutral-900">
                            {String(h).padStart(2, "0")}:00
                          </option>
                        ))}
                      </select>
                      <span className="text-[11px] text-cyan-200">
                        Todo dia às <strong className="text-white text-sm">{String(hourDraft).padStart(2, "0")}h</strong>
                      </span>
                    </div>
                    {org?.lastRun && (
                      <p className="text-[10px] text-muted-foreground italic">
                        Última execução: {new Date(org.lastRun).toLocaleString("pt-BR")}
                      </p>
                    )}
                  </div>
                </div>

                {/* ----- 3. MODELO (info-only) ----- */}
                <div className="rounded-xl bg-black/30 p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-cyan-500/20 text-cyan-300 text-[11px] font-black flex items-center justify-center">3</span>
                    <p className="text-xs font-bold text-white">Qual IA está pensando por você</p>
                  </div>
                  <div className="pl-8 space-y-1.5">
                    <div className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm font-mono text-white/90 flex items-center justify-between gap-2">
                      <span>{org?.model}</span>
                      <span className="text-[9px] text-muted-foreground uppercase tracking-widest">
                        {org?.isAdmin ? "altere no card roxo acima" : "definido pelo admin"}
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      O modelo (cérebro da IA) é escolhido pelo admin pra todo o sistema. Modelos mais inteligentes acertam mais — mas custam mais.
                    </p>
                  </div>
                </div>

                {/* ----- 4. PROMPT — A PARTE MAIS IMPORTANTE ----- */}
                <div className="rounded-xl bg-black/30 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-cyan-500/20 text-cyan-300 text-[11px] font-black flex items-center justify-center">4</span>
                    <p className="text-xs font-bold text-white">Como a IA deve pensar (Prompt)</p>
                  </div>

                  <div className="pl-8 space-y-3">
                    {/* Explicação do que é prompt — para iniciantes */}
                    <div className="rounded-lg bg-cyan-500/[0.08] border border-cyan-500/20 p-3 space-y-1.5">
                      <p className="text-[11px] text-cyan-100 leading-relaxed">
                        <strong>O que é o prompt?</strong> É o manual que você dá pra IA. Igual a treinar um funcionário novo: você explica o seu negócio, quais critérios usar pra mover um cliente de uma coluna pra outra, e o que NÃO fazer.
                      </p>
                      <p className="text-[10px] text-cyan-200/80 leading-relaxed">
                        <strong>Você não precisa escrever nada</strong> — se deixar vazio, a IA usa o manual padrão (já bom pra qualquer nicho). Mas se quiser personalizar pro SEU negócio (ex.: "se cliente disser que está grávida, não sugerir esmalte tóxico"), escreva aqui.
                      </p>
                    </div>

                    {/* Status atual: padrão ou customizado */}
                    <div className={cn(
                      "rounded-lg p-3 border text-[11px]",
                      promptDraft
                        ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-200"
                        : "bg-white/[0.03] border-white/10 text-muted-foreground"
                    )}>
                      {promptDraft ? (
                        <>✓ <strong>Você tem um prompt customizado.</strong> A IA segue as suas instruções (+ as regras técnicas R1-R17 e seu kanban automaticamente).</>
                      ) : (
                        <>○ <strong>Usando o manual padrão.</strong> Funciona pra qualquer nicho. Personalize só se quiser regras específicas do seu negócio.</>
                      )}
                    </div>

                    {/* Ações rápidas pra escrever */}
                    <div className="flex items-center gap-2 flex-wrap">
                      {!promptDraft && org?.defaultPrompt && (
                        <button
                          type="button"
                          onClick={() => setPromptDraft(org.defaultPrompt)}
                          className="text-[10px] px-2.5 py-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/30 text-cyan-200 hover:bg-cyan-500/25 flex items-center gap-1.5"
                        >
                          <FileText className="w-3 h-3" /> Começar com o manual padrão
                        </button>
                      )}
                      {promptDraft && (
                        <button
                          type="button"
                          onClick={() => { if (confirm("Voltar pro manual padrão? Seu texto custom será apagado.")) setPromptDraft(""); }}
                          className="text-[10px] px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-muted-foreground hover:text-red-300 hover:border-red-500/30 flex items-center gap-1.5"
                        >
                          <RefreshCw className="w-3 h-3" /> Voltar pro manual padrão
                        </button>
                      )}
                      <span className="text-[10px] text-muted-foreground">
                        ou role pra baixo até <strong className="text-purple-300">Sugestão automática</strong> pra a IA gerar pra você
                      </span>
                    </div>

                    {/* Textarea */}
                    <Textarea
                      value={promptDraft}
                      onChange={(e) => setPromptDraft(e.target.value)}
                      placeholder={`Exemplo:

Sou dona de um salão de manicure.
Mova o lead pra "agendado" quando ele confirmar data+horário.
Se a cliente pedir pra remarcar, mantenha "agendado".
Se mandar foto da unha pronta + agradecimento, mova pra "atendido".
NUNCA mova de "agendado" pra "interessado" só porque ela perguntou algo.

(Deixe vazio pra usar o manual padrão — funciona pra qualquer nicho.)`}
                      className="bg-black/40 border-white/10 min-h-[180px] text-xs leading-relaxed"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      💡 <strong>Dica:</strong> escreva em português normal, como se estivesse explicando pra uma pessoa. A IA entende. Pra ver o texto FINAL completo (seu prompt + regras técnicas + seu kanban), abra o card amarelo "Prompt completo que está rodando" mais abaixo.
                    </p>
                  </div>
                </div>

                {/* ----- BOTÃO SALVAR ----- */}
                <div className="flex items-center justify-end gap-3 pt-2 border-t border-cyan-500/10">
                  {promptDirty && (
                    <span className="text-[11px] text-amber-300 flex items-center gap-1">
                      <AlertCircle className="w-3.5 h-3.5" /> Você tem alterações sem salvar
                    </span>
                  )}
                  <Button
                    onClick={saveOrg}
                    disabled={savingOrg || !promptDirty}
                    className={cn("text-sm gap-2 px-5 h-10", promptDirty ? "bg-cyan-600 hover:bg-cyan-500 text-white glow-primary" : "bg-white/5 text-muted-foreground")}
                  >
                    {savingOrg ? <><Loader2 className="w-4 h-4 animate-spin" /> Salvando…</> : <><Save className="w-4 h-4" /> Salvar configuração</>}
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
                    A IA lê o agente escolhido (prompt, função, base de conhecimento), identifica o nicho e gera DOIS pacotes prontos: (1) colunas de Kanban com vocabulário do nicho, (2) prompt completo do Organizador — REESCRITA do template padrão R1-R17 adaptada ao nicho + status_keys reais. Você revisa, edita e aplica.
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

                {/* Movimentações — busca, expand, delete por item, clear-all */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p className="text-[10px] uppercase font-black tracking-widest text-muted-foreground">
                      Movimentações ({filteredHistory.length}{historyQuery && ` de ${history.length}`})
                    </p>
                    <div className="flex items-center gap-2">
                      <div className="relative">
                        <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          value={historyQuery}
                          onChange={(e) => setHistoryQuery(e.target.value)}
                          placeholder="filtrar (nome, status, razão…)"
                          className="bg-black/30 border-white/10 h-7 text-[10px] pl-7 w-56"
                        />
                      </div>
                      {history.length > 0 && (
                        <Button
                          onClick={clearAllHistory}
                          disabled={clearingHistory}
                          variant="outline"
                          className="text-[10px] h-7 px-2 gap-1 text-red-300 border-red-500/30 hover:bg-red-500/10"
                        >
                          {clearingHistory ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                          Limpar tudo
                        </Button>
                      )}
                    </div>
                  </div>

                  {filteredHistory.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground italic">
                      {history.length === 0 ? "Nenhuma movimentação ainda." : "Nada bate com o filtro."}
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {filteredHistory.map((h) => {
                        const moved = h.status_antigo !== h.status_novo;
                        const expanded = expandedHistoryId === h.id;
                        return (
                          <div key={h.id} className="rounded border border-white/5 bg-black/20 overflow-hidden">
                            <button
                              type="button"
                              onClick={() => setExpandedHistoryId(expanded ? null : h.id)}
                              className="w-full flex items-start gap-2 p-2 text-left text-[11px] hover:bg-white/[0.03]"
                            >
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
                              <span className="text-muted-foreground italic truncate flex-1 min-w-0">{h.razao}</span>
                              <span className="text-muted-foreground/60 shrink-0 text-[9px]">{new Date(h.created_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                              {expanded ? <ChevronUp className="w-3 h-3 text-muted-foreground shrink-0" /> : <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />}
                            </button>
                            {expanded && (
                              <div className="border-t border-white/5 p-3 space-y-2 bg-black/30 text-[11px]">
                                <div className="grid grid-cols-2 gap-2 text-[10px]">
                                  <div><span className="text-muted-foreground">JID:</span> <code className="text-white/80">{h.remote_jid}</code></div>
                                  <div><span className="text-muted-foreground">Data:</span> <span className="text-white/80">{new Date(h.created_at).toLocaleString("pt-BR")}</span></div>
                                  {h.batch_id && <div className="col-span-2 truncate"><span className="text-muted-foreground">Batch:</span> <code className="text-white/60">{h.batch_id}</code></div>}
                                </div>
                                <div>
                                  <p className="text-[9px] uppercase tracking-widest text-muted-foreground font-black mb-0.5">Razão completa</p>
                                  <p className="text-white/90 whitespace-pre-wrap">{h.razao || <span className="italic text-muted-foreground">—</span>}</p>
                                </div>
                                <div>
                                  <p className="text-[9px] uppercase tracking-widest text-muted-foreground font-black mb-0.5">Resumo da IA</p>
                                  <p className="text-white/90 whitespace-pre-wrap">{h.resumo || <span className="italic text-muted-foreground">— sem resumo —</span>}</p>
                                </div>
                                <div className="flex justify-end pt-1 border-t border-white/5">
                                  <Button
                                    onClick={(e) => { e.stopPropagation(); deleteHistoryItem(h.id); }}
                                    variant="outline"
                                    className="text-[10px] h-7 px-2 gap-1 text-red-300 border-red-500/30 hover:bg-red-500/10"
                                  >
                                    <Trash2 className="w-3 h-3" /> Apagar
                                  </Button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </section>

              {/* ============= PROMPT EFETIVO COMPLETO ============= */}
              <section className="rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/[0.04] to-transparent p-5 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <h2 className="text-sm font-bold flex items-center gap-2 text-amber-200">
                      <FileText className="w-4 h-4" /> Prompt completo que está rodando
                    </h2>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      O texto EXATO enviado pra IA agora: {effective?.customPrompt ? "seu prompt customizado" : "prompt padrão SDR (R1-R17)"} + colunas do seu kanban + data de hoje.
                    </p>
                  </div>
                  <Button
                    onClick={() => setEffectiveVisible((v) => !v)}
                    variant="outline"
                    className="text-[10px] h-7 px-2 gap-1"
                  >
                    {effectiveVisible ? <><EyeOff className="w-3 h-3" /> Ocultar</> : <><Eye className="w-3 h-3" /> Ver / editar</>}
                  </Button>
                </div>

                {effectiveVisible && effective && (
                  <div className="space-y-3">
                    {/* ----- AÇÃO: GERAR PROMPT SUGERIDO COM IA ----- */}
                    <div className="rounded-xl bg-purple-500/[0.06] border border-purple-500/20 p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2 flex-wrap">
                        <div>
                          <p className="text-[11px] font-bold text-purple-200 flex items-center gap-1.5">
                            <Wand2 className="w-3.5 h-3.5" /> Gerar prompt sugerido pra esse kanban
                          </p>
                          <p className="text-[10px] text-muted-foreground mt-0.5 max-w-xl">
                            A IA lê o agente IA da conta + as colunas do seu kanban atual e reescreve o template R1-R17 adaptado ao seu nicho usando os status_keys reais. Você revisa antes de aplicar.
                          </p>
                        </div>
                        <Button
                          onClick={generatePromptSuggestion}
                          disabled={promptSuggesting || columns.length === 0 || (org?.agents?.length || 0) === 0}
                          className="bg-purple-600 hover:bg-purple-500 text-white text-[11px] h-8 gap-1.5"
                        >
                          {promptSuggesting ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Gerando…</> : <><Sparkles className="w-3.5 h-3.5" /> Gerar sugestão</>}
                        </Button>
                      </div>
                      {(columns.length === 0 || (org?.agents?.length || 0) === 0) && (
                        <p className="text-[10px] text-amber-300">
                          {(org?.agents?.length || 0) === 0
                            ? "Crie um agente IA em /agente primeiro."
                            : "Configure colunas no Kanban antes."}
                        </p>
                      )}
                    </div>

                    {/* Preview da sugestão com aprovação */}
                    {promptSuggestion && (
                      <div className="rounded-xl border border-purple-500/30 bg-purple-500/[0.05] p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <p className="text-[11px] font-bold text-purple-200">
                            Sugestão pronta · nicho identificado: <span className="text-white">{promptSuggestion.business_type}</span>
                          </p>
                          <div className="flex gap-1.5">
                            <Button onClick={() => setPromptSuggestion(null)} variant="outline" className="text-[10px] h-7 px-2">
                              Descartar
                            </Button>
                            <Button onClick={generatePromptSuggestion} disabled={promptSuggesting} variant="outline" className="text-[10px] h-7 px-2 gap-1">
                              <RefreshCw className="w-3 h-3" /> Gerar outra
                            </Button>
                            <Button onClick={applyPromptSuggestion} disabled={savingOrg} className="bg-purple-600 hover:bg-purple-500 text-white text-[10px] h-7 px-2 gap-1">
                              {savingOrg ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Aplicar como meu prompt
                            </Button>
                          </div>
                        </div>
                        <Textarea
                          value={promptSuggestion.organizer_prompt}
                          onChange={(e) => setPromptSuggestion({ ...promptSuggestion, organizer_prompt: e.target.value })}
                          className="bg-black/40 border-white/10 min-h-[280px] text-[10px] font-mono"
                        />
                        <p className="text-[9px] text-muted-foreground italic">
                          Você pode editar livremente antes de aplicar. Quando aplicar, vira o seu prompt customizado dessa conta (substitui o padrão).
                        </p>
                      </div>
                    )}

                    {/* Bloco 1: prompt base (custom OU padrão) */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-[10px] uppercase font-black tracking-widest text-amber-300">
                          1. Prompt base — {effective.customPrompt ? "seu customizado (editável no card cyan acima)" : "padrão R1-R17 (editável aqui)"}
                        </p>
                        {!effective.customPrompt && (
                          <button onClick={() => setEditingDefault((e) => !e)} className="text-[10px] text-amber-300 hover:underline flex items-center gap-1">
                            <Pencil className="w-3 h-3" /> {editingDefault ? "Cancelar edição" : "Editar padrão pra essa conta"}
                          </button>
                        )}
                      </div>
                      {effective.customPrompt ? (
                        <pre className="bg-black/40 border border-white/5 rounded-xl p-3 text-[10px] text-white/80 font-mono whitespace-pre-wrap max-h-64 overflow-y-auto">{effective.customPrompt}</pre>
                      ) : editingDefault ? (
                        <div className="space-y-2">
                          <Textarea
                            value={defaultDraft}
                            onChange={(e) => setDefaultDraft(e.target.value)}
                            className="bg-black/40 border-white/10 h-80 text-[10px] font-mono"
                          />
                          <div className="flex justify-end gap-2">
                            <Button onClick={() => { setDefaultDraft(effective.defaultBasePrompt); setEditingDefault(false); }} variant="outline" className="text-[10px] h-7 px-2">
                              Cancelar
                            </Button>
                            <Button
                              onClick={async () => {
                                // Salvar como prompt customizado do cliente
                                setPromptDraft(defaultDraft);
                                const r = await fetch("/api/organizer", {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ enabled: enabledDraft, prompt: defaultDraft, executionHour: hourDraft }),
                                });
                                const d = await r.json();
                                if (!d.ok) { alert("Erro: " + d.error); return; }
                                setInfo("Prompt salvo como customizado pra essa conta");
                                setTimeout(() => setInfo(null), 2500);
                                setEditingDefault(false);
                                reload();
                              }}
                              className="bg-amber-600 hover:bg-amber-500 text-white text-[10px] h-7 px-2 gap-1"
                            >
                              <Save className="w-3 h-3" /> Salvar como meu
                            </Button>
                          </div>
                          <p className="text-[9px] text-muted-foreground italic">
                            Salvar vira o prompt customizado DESTA conta (não afeta outras contas).
                          </p>
                        </div>
                      ) : (
                        <pre className="bg-black/40 border border-white/5 rounded-xl p-3 text-[10px] text-white/80 font-mono whitespace-pre-wrap max-h-64 overflow-y-auto">{effective.defaultBasePrompt}</pre>
                      )}
                    </div>

                    {/* Bloco 2: apêndice do kanban */}
                    <div>
                      <p className="text-[10px] uppercase font-black tracking-widest text-amber-300 mb-1">
                        2. Apêndice automático do seu kanban
                      </p>
                      <pre className="bg-black/40 border border-white/5 rounded-xl p-3 text-[10px] text-white/80 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
                        {effective.kanbanAppendix.trim() || "(nenhuma coluna no kanban — apêndice vazio)"}
                      </pre>
                    </div>

                    {/* Bloco 3: contexto de data */}
                    <div>
                      <p className="text-[10px] uppercase font-black tracking-widest text-amber-300 mb-1">
                        3. Contexto temporal (atualizado a cada execução)
                      </p>
                      <pre className="bg-black/40 border border-white/5 rounded-xl p-3 text-[10px] text-white/80 font-mono whitespace-pre-wrap">
                        {effective.dateContext.trim()}
                      </pre>
                    </div>

                    {/* Copy do prompt completo */}
                    <div className="flex justify-end pt-2 border-t border-amber-500/10">
                      <Button
                        onClick={() => {
                          navigator.clipboard.writeText(effective.fullPrompt);
                          setInfo("Prompt completo copiado");
                          setTimeout(() => setInfo(null), 2000);
                        }}
                        variant="outline"
                        className="text-[10px] h-7 px-2 gap-1"
                      >
                        <ClipboardCheck className="w-3 h-3" /> Copiar prompt completo
                      </Button>
                    </div>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
