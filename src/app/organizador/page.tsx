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
} from "lucide-react";

type OrganizerState = {
  enabled: boolean;
  prompt: string;
  defaultPrompt: string;
  effectivePrompt: string;     // o que a IA REALMENTE recebe (custom ou default)
  globalEnabled: boolean;
  lastRun: string | null;
  executionHour: number;
  model: string;                // modelo global em uso (só admin altera)
  provider: string;
  isAdmin: boolean;             // pra UI mostrar/esconder o select de modelo
};

type AiModel = { id: string; name: string; description?: string };

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

const DEFAULT_COLOR = "#6b7280";
const PRESET_COLORS = [
  "#3b82f6", "#06b6d4", "#10b981", "#22c55e", "#eab308",
  "#f97316", "#ef4444", "#a855f7", "#ec4899", "#6b7280",
];

export default function OrganizadorPage() {
  const [org, setOrg] = useState<OrganizerState | null>(null);
  const [columns, setColumns] = useState<KanbanColumn[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingOrg, setSavingOrg] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Prompt editor (controlled)
  const [promptDraft, setPromptDraft] = useState("");
  const [enabledDraft, setEnabledDraft] = useState(true);

  // Kanban editor
  const [newColLabel, setNewColLabel] = useState("");
  const [newColColor, setNewColColor] = useState(DEFAULT_COLOR);

  // IA suggest
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);

  // Modelos Gemini em tempo real (/api/ai-models) — só admin altera
  const [models, setModels] = useState<AiModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [savingModel, setSavingModel] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [orgRes, kbRes] = await Promise.all([
        fetch("/api/organizer", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/kanban-columns", { cache: "no-store" }).then((r) => r.json()),
      ]);
      if (orgRes.ok) {
        setOrg({
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
        });
        setPromptDraft(orgRes.prompt || "");
        setEnabledDraft(orgRes.enabled);
      }
      if (kbRes.ok) setColumns(kbRes.columns);

      // Carrega modelos em tempo real só se for admin (cliente nem precisa)
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
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // ============= SAVE MODEL (só admin) =============
  const saveModel = async (newModel: string) => {
    if (!org || newModel === org.model) return;
    setSavingModel(true);
    setError(null);
    try {
      const r = await fetch("/api/organizer/model", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: newModel }),
      });
      const d = await r.json();
      if (!d.ok) setError(d.error || "Falha ao salvar modelo");
      else {
        setInfo("Modelo atualizado pra " + newModel);
        setTimeout(() => setInfo(null), 3000);
        reload();
      }
    } finally {
      setSavingModel(false);
    }
  };

  // ============= SAVE ORG (prompt + enabled) =============
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
      if (!d.ok) setError(d.error || "Falha ao salvar");
      else { setInfo("Organizador salvo"); setTimeout(() => setInfo(null), 2500); reload(); }
    } finally {
      setSavingOrg(false);
    }
  };

  // ============= KANBAN: criar, editar, mover, deletar =============
  const addColumn = async () => {
    const label = newColLabel.trim();
    if (!label) return;
    const status_key = label.toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "") // tira acentos
      .replace(/[^a-z0-9]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");
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
    const r = await fetch(`/api/kanban-columns/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const d = await r.json();
    if (!d.ok) alert("Erro: " + d.error);
  };

  const deleteColumn = async (col: KanbanColumn) => {
    if (col.is_system) { alert("Coluna de sistema não pode ser apagada"); return; }
    if (!confirm(`Apagar coluna "${col.label}"?\n\nLeads com este status NÃO serão apagados, mas ficarão "órfãos" no Kanban — você precisa movê-los pra outra coluna depois.`)) return;
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
    // Re-numera order_index sequencial
    const updates = swap.map((c, i) => ({ id: c.id, order_index: i }));
    setColumns(swap.map((c, i) => ({ ...c, order_index: i }))); // otimista
    await fetch("/api/kanban-columns", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columns: updates }),
    });
  };

  // ============= IA SUGGEST =============
  const generateSuggestion = async () => {
    setSuggesting(true);
    setError(null);
    setSuggestion(null);
    try {
      const r = await fetch("/api/organizer/suggest-kanban", { method: "POST" });
      const d = await r.json();
      if (!d.ok) { setError(d.error || "Falha ao gerar sugestão"); return; }
      setSuggestion(d.suggestion);
    } finally {
      setSuggesting(false);
    }
  };

  const applySuggestion = async () => {
    if (!suggestion) return;
    if (!confirm(
      `Aplicar sugestão da IA?\n\n` +
      `- ${suggestion.columns.length} colunas do Kanban serão SUBSTITUÍDAS (as atuais não-sistema são apagadas)\n` +
      `- O prompt do Organizador IA será substituído pelo sugerido\n\n` +
      `Esta ação não é reversível automaticamente.`
    )) return;

    setSuggesting(true);
    try {
      // 1. Apaga colunas não-system existentes
      const toDelete = columns.filter((c) => !c.is_system);
      await Promise.all(toDelete.map((c) =>
        fetch(`/api/kanban-columns/${c.id}`, { method: "DELETE" })
      ));

      // 2. Cria as novas (mantém as is_system existentes no início)
      const systemCount = columns.filter((c) => c.is_system).length;
      for (let i = 0; i < suggestion.columns.length; i++) {
        const col = suggestion.columns[i];
        // Pula se já existe coluna system com mesmo status_key
        if (columns.some((c) => c.is_system && c.status_key === col.status_key)) continue;
        await fetch("/api/kanban-columns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status_key: col.status_key,
            label: col.label,
            color: col.color,
            order_index: systemCount + i,
          }),
        });
      }

      // 3. Substitui prompt
      await fetch("/api/organizer", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: enabledDraft, prompt: suggestion.organizer_prompt }),
      });

      setSuggestion(null);
      setInfo("Sugestão aplicada com sucesso");
      setTimeout(() => setInfo(null), 4000);
      reload();
    } finally {
      setSuggesting(false);
    }
  };

  const promptDirty = (org?.prompt || "") !== promptDraft || (org?.enabled ?? true) !== enabledDraft;

  return (
    <div className="flex flex-col h-[100dvh] bg-background overflow-hidden text-white">
      <Header />

      <main className="flex-1 overflow-y-auto w-full">
        <div className="max-w-5xl mx-auto p-4 sm:p-8 space-y-6">
          {/* Title */}
          <div>
            <h1 className="text-2xl font-black tracking-tight flex items-center gap-3">
              <Bot className="w-7 h-7 text-purple-400" /> Organizador IA
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              IA que lê suas conversas e classifica leads no Kanban automaticamente.
              Configure o comportamento, edite as colunas, ou peça uma sugestão personalizada pro seu negócio.
            </p>
          </div>

          {/* Status global warning */}
          {org && !org.globalEnabled && (
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-200 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                O Organizador IA está <strong>desligado globalmente</strong> em Configurações.
                Mesmo com toggle ativo aqui, ele não vai rodar até o admin ligar o global.
              </span>
            </div>
          )}

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
              {/* ============= SEÇÃO 0: EM USO AGORA (read-only summary) ============= */}
              <section className="rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-cyan-500/[0.06] to-transparent p-5 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <h2 className="text-sm font-bold flex items-center gap-2 text-cyan-200">
                    <Sparkles className="w-4 h-4" /> Em uso agora
                  </h2>
                  <div className="flex items-center gap-2 text-[10px]">
                    <span className={cn(
                      "px-2 py-1 rounded font-black uppercase tracking-widest",
                      org?.enabled && org?.globalEnabled
                        ? "bg-emerald-500/20 text-emerald-300"
                        : "bg-amber-500/20 text-amber-300"
                    )}>
                      {!org?.globalEnabled ? "GLOBAL OFF" : !org?.enabled ? "Cliente OFF" : "Ativo"}
                    </span>
                  </div>
                </div>

                {/* Modelo ativo — só admin pode mudar */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] font-black uppercase tracking-widest text-cyan-300">
                      Modelo de IA {org?.isAdmin ? "(você pode alterar)" : "(definido pelo admin)"}
                    </label>
                    {modelsLoading && (
                      <span className="text-[9px] text-muted-foreground flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" /> buscando modelos…
                      </span>
                    )}
                    {!modelsLoading && org?.isAdmin && models.length > 0 && (
                      <span className="text-[9px] text-emerald-400">{models.length} modelos Gemini (ao vivo)</span>
                    )}
                  </div>

                  {org?.isAdmin ? (
                    <select
                      value={org.model}
                      onChange={(e) => saveModel(e.target.value)}
                      disabled={savingModel}
                      className="w-full bg-black/40 border border-cyan-500/20 h-11 rounded-xl text-sm px-3 font-mono disabled:opacity-50"
                    >
                      {/* Garante que o valor salvo aparece mesmo se não veio na lista */}
                      {org.model && !models.some((m) => m.id === org.model) && (
                        <option value={org.model}>{org.model} (salvo)</option>
                      )}
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>{m.name} ({m.id})</option>
                      ))}
                      {models.length === 0 && !modelsLoading && (
                        <option value={org.model}>{org.model}</option>
                      )}
                    </select>
                  ) : (
                    <div className="px-3 py-2.5 rounded-xl bg-black/30 border border-white/10 text-sm font-mono text-white/90 flex items-center justify-between">
                      <span>{org?.model}</span>
                      <span className="text-[9px] text-muted-foreground uppercase">readonly</span>
                    </div>
                  )}
                  {savingModel && (
                    <p className="text-[10px] text-amber-300 flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" /> Atualizando modelo no servidor…
                    </p>
                  )}
                </div>

                {/* Prompt efetivo (read-only) */}
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase tracking-widest text-cyan-300">
                    Prompt em uso (efetivo)
                    {!org?.prompt && <span className="text-muted-foreground normal-case font-normal ml-1">— usando padrão global</span>}
                  </label>
                  <pre className="bg-black/40 border border-cyan-500/15 rounded p-3 text-[11px] text-white/85 whitespace-pre-wrap font-mono leading-relaxed max-h-48 overflow-y-auto">
                    {org?.effectivePrompt || "(vazio)"}
                  </pre>
                  <p className="text-[9px] text-muted-foreground italic">
                    Esse é o texto exato que a IA recebe a cada execução. Edite abaixo na seção "Status + Prompt" pra customizar.
                  </p>
                </div>
              </section>

              {/* ============= SEÇÃO 1: STATUS + PROMPT ============= */}
              <section className="glass-card rounded-2xl border-white/10 bg-white/[0.02] p-5 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-bold flex items-center gap-2">
                      <Power className="w-4 h-4" /> Status + Prompt
                    </h2>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Última execução: <strong>{org?.lastRun ? new Date(org.lastRun).toLocaleString("pt-BR") : "nunca"}</strong>
                      {" · "}Hora agendada: <strong>{org?.executionHour}h</strong>
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      "text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-md",
                      enabledDraft ? "bg-emerald-500/20 text-emerald-300" : "bg-white/10 text-muted-foreground"
                    )}>
                      {enabledDraft ? "Ativo" : "Desligado"}
                    </span>
                    <button
                      type="button"
                      onClick={() => setEnabledDraft(!enabledDraft)}
                      className={cn("w-12 h-6 rounded-full p-1 transition", enabledDraft ? "bg-purple-500" : "bg-white/10")}
                    >
                      <div className={cn("w-4 h-4 rounded-full bg-white transition-all", enabledDraft && "translate-x-6")} />
                    </button>
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] font-black uppercase tracking-widest text-purple-300">Prompt do Organizador</label>
                    <div className="flex gap-1">
                      {promptDraft && (
                        <button type="button" onClick={() => setPromptDraft("")} className="text-[10px] text-muted-foreground hover:text-red-400">
                          Limpar (usar padrão global)
                        </button>
                      )}
                      {!promptDraft && org?.defaultPrompt && (
                        <button type="button" onClick={() => setPromptDraft(org.defaultPrompt)} className="text-[10px] text-purple-300 hover:underline">
                          Ver/editar prompt padrão
                        </button>
                      )}
                    </div>
                  </div>
                  <Textarea
                    value={promptDraft}
                    onChange={(e) => setPromptDraft(e.target.value)}
                    placeholder="Vazio = usa o prompt padrão. Personalize aqui pra adaptar a IA ao seu negócio (vendas, atendimento, agendamento, suporte, e-commerce, etc)."
                    className="bg-black/40 border-white/10 h-44 text-xs font-mono"
                  />
                  <p className="text-[9px] text-muted-foreground italic">
                    A IA recebe esse prompt + histórico de conversa + lista de status do Kanban,
                    e devolve qual coluna o lead deve ir.
                  </p>
                </div>

                <div className="flex items-center justify-end gap-2">
                  {promptDirty && <span className="text-[10px] text-amber-300">Alterações não salvas</span>}
                  <Button
                    onClick={saveOrg}
                    disabled={savingOrg || !promptDirty}
                    className={cn("text-xs gap-2", promptDirty ? "glow-primary" : "bg-white/5 text-muted-foreground")}
                  >
                    {savingOrg ? <><Loader2 className="w-4 h-4 animate-spin" /> Salvando</> : <><Save className="w-4 h-4" /> Salvar</>}
                  </Button>
                </div>
              </section>

              {/* ============= SEÇÃO 2: KANBAN EDITOR ============= */}
              <section className="glass-card rounded-2xl border-white/10 bg-white/[0.02] p-5 space-y-4">
                <div>
                  <h2 className="text-sm font-bold">Colunas do Kanban</h2>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Edite nomes, cores e ordem. A coluna marcada como sistema não pode ser apagada (mas pode renomear/recolorir).
                  </p>
                </div>

                {/* Lista de colunas */}
                <div className="space-y-1.5">
                  {columns.map((col, idx) => (
                    <div key={col.id} className="flex items-center gap-2 p-2 rounded-lg bg-black/30 border border-white/5">
                      <div className="flex flex-col">
                        <button
                          type="button"
                          onClick={() => moveColumn(idx, -1)}
                          disabled={idx === 0}
                          className="h-4 w-5 text-muted-foreground hover:text-white disabled:opacity-20 flex items-center justify-center"
                          title="Mover pra cima"
                        ><ChevronUp className="w-3 h-3" /></button>
                        <button
                          type="button"
                          onClick={() => moveColumn(idx, 1)}
                          disabled={idx === columns.length - 1}
                          className="h-4 w-5 text-muted-foreground hover:text-white disabled:opacity-20 flex items-center justify-center"
                          title="Mover pra baixo"
                        ><ChevronDown className="w-3 h-3" /></button>
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
                        onBlur={(e) => {
                          if (e.target.value.trim() !== col.label) updateColumn(col.id, { label: e.target.value.trim() });
                        }}
                        className="flex-1 bg-white/5 border-white/10 h-9 text-sm"
                      />
                      <code className="text-[10px] text-muted-foreground font-mono shrink-0 px-2 py-1 bg-black/40 rounded">
                        {col.status_key}
                      </code>
                      {col.is_system && (
                        <span className="text-[9px] uppercase font-black tracking-widest text-amber-300 bg-amber-500/10 border border-amber-500/20 px-2 py-1 rounded">
                          sistema
                        </span>
                      )}
                      <Button
                        onClick={() => deleteColumn(col)}
                        disabled={col.is_system}
                        size="icon" variant="ghost"
                        className="h-8 w-8 text-red-400 hover:bg-red-500/10 disabled:opacity-30"
                        title={col.is_system ? "Coluna de sistema" : "Apagar"}
                      ><Trash2 className="w-3.5 h-3.5" /></Button>
                    </div>
                  ))}
                </div>

                {/* Add nova coluna */}
                <div className="flex items-center gap-2 p-2 rounded-lg bg-cyan-500/5 border border-cyan-500/20">
                  <input
                    type="color"
                    value={newColColor}
                    onChange={(e) => setNewColColor(e.target.value)}
                    className="w-8 h-8 rounded cursor-pointer bg-transparent border border-white/10"
                  />
                  <Input
                    value={newColLabel}
                    onChange={(e) => setNewColLabel(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addColumn()}
                    placeholder="Nome da nova coluna (ex: Em negociação)"
                    className="flex-1 bg-white/5 border-white/10 h-9 text-sm"
                  />
                  <div className="flex gap-0.5">
                    {PRESET_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setNewColColor(c)}
                        className={cn("w-5 h-5 rounded border-2", newColColor === c ? "border-white" : "border-transparent")}
                        style={{ background: c }}
                        title={c}
                      />
                    ))}
                  </div>
                  <Button onClick={addColumn} disabled={!newColLabel.trim()} className="text-xs gap-1">
                    <Plus className="w-3 h-3" /> Adicionar
                  </Button>
                </div>
              </section>

              {/* ============= SEÇÃO 3: IA SUGGEST ============= */}
              <section className="glass-card rounded-2xl border-purple-500/30 bg-gradient-to-br from-purple-500/[0.04] to-transparent p-5 space-y-4">
                <div>
                  <h2 className="text-sm font-bold flex items-center gap-2">
                    <Wand2 className="w-4 h-4 text-purple-400" /> Sugestão automática (IA)
                  </h2>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    A IA analisa o agente que você criou (prompt, função, conhecimento) e
                    sugere um Kanban + prompt do Organizador adequados ao seu nicho.
                  </p>
                </div>

                {!suggestion && (
                  <Button
                    onClick={generateSuggestion}
                    disabled={suggesting}
                    className="bg-purple-600 hover:bg-purple-500 text-white text-xs gap-2"
                  >
                    {suggesting ? <><Loader2 className="w-4 h-4 animate-spin" /> Analisando seu agente…</> : <><Sparkles className="w-4 h-4" /> Gerar sugestão pro meu negócio</>}
                  </Button>
                )}

                {suggestion && (
                  <div className="space-y-4">
                    <div className="p-3 rounded-xl bg-black/30 border border-purple-500/20">
                      <p className="text-[10px] uppercase font-black tracking-widest text-purple-300">Negócio identificado</p>
                      <p className="text-sm text-white mt-1">{suggestion.business_type}</p>
                    </div>

                    <div>
                      <p className="text-[10px] uppercase font-black tracking-widest text-purple-300 mb-2">
                        Colunas sugeridas ({suggestion.columns.length})
                      </p>
                      <div className="space-y-1">
                        {suggestion.columns.map((c, i) => (
                          <div key={i} className="flex items-center gap-2 p-2 rounded bg-black/20 border border-white/5">
                            <div className="w-4 h-4 rounded shrink-0" style={{ background: c.color }} />
                            <span className="text-sm font-bold">{c.label}</span>
                            <code className="text-[9px] text-muted-foreground font-mono">{c.status_key}</code>
                            {c.rationale && <span className="text-[10px] text-muted-foreground ml-auto truncate">{c.rationale}</span>}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div>
                      <p className="text-[10px] uppercase font-black tracking-widest text-purple-300 mb-2">Prompt sugerido</p>
                      <pre className="bg-black/40 border border-white/10 rounded p-3 text-[11px] whitespace-pre-wrap font-mono leading-relaxed max-h-40 overflow-y-auto">
                        {suggestion.organizer_prompt}
                      </pre>
                    </div>

                    <div className="flex justify-end gap-2 pt-2 border-t border-purple-500/10">
                      <Button onClick={() => setSuggestion(null)} variant="outline" className="text-xs">
                        Descartar
                      </Button>
                      <Button onClick={generateSuggestion} disabled={suggesting} variant="outline" className="text-xs gap-1">
                        <RefreshCw className="w-3 h-3" /> Gerar outra
                      </Button>
                      <Button onClick={applySuggestion} disabled={suggesting} className="bg-purple-600 hover:bg-purple-500 text-xs gap-1">
                        {suggesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Aplicar tudo
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
