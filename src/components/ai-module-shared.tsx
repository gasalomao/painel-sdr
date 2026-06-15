"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Bot, ChevronDown, Loader2, Sparkles, Search, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMemo, useState } from "react";
import { useAiModels } from "@/hooks/use-ai-models";
import { groupModels, type GroupableModel } from "@/lib/model-grouping";

interface AIModelSelectProps {
  value: string;
  onChange: (model: string) => void;
  label?: string;
  compact?: boolean;
  /** Se true, marca/filtra modelos que suportam ferramentas (Agente SDR). */
  requireTools?: boolean;
}

const PROVIDER_LABEL: Record<string, string> = {
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
  gateway: "Gateway (Assinatura)",
};

// Cor do cabeçalho de cada grupo de provedor no dropdown.
const PROVIDER_COLOR: Record<string, string> = {
  gemini: "text-blue-400",
  openrouter: "text-purple-400",
  gateway: "text-emerald-400",
};

// Dropdown de modelos — 100% em tempo real via /api/ai-models. Agrupa por
// provedor (Gemini / OpenRouter / Gateway de Assinatura) e tem busca, porque o
// OpenRouter expõe 300+. Sem lista hardcoded: modelo novo de qualquer fonte
// aparece sem deploy.
export function AIModelSelect({ value, onChange, label = "Modelo IA", compact = false, requireTools = false }: AIModelSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { models, loading, error } = useAiModels();

  const currentModel = models.find(m => m.id === value);
  const providerName = currentModel?.provider ? PROVIDER_LABEL[currentModel.provider] : "";
  const modelLabel = currentModel
    ? `${providerName} — ${currentModel.rawId || currentModel.name}`
    : (value || "(selecionar)");

  // Filtro por busca (id, nome, provedor) + agrupamento por provedor e subgrupo
  // (OpenRouter: Grátis/família; Gateway: família da assinatura).
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = models.filter(m => {
      if (!q) return true;
      return (m.rawId || m.id).toLowerCase().includes(q)
        || (m.name || "").toLowerCase().includes(q)
        || (m.provider || "").toLowerCase().includes(q);
    });
    return groupModels(filtered);
  }, [models, query]);

  // Total de itens visíveis (pós-filtro), pra mostrar no cabeçalho.
  const visibleCount = useMemo(
    () => groups.reduce((n, g) => n + g.subgroups.reduce((s, sg) => s + sg.items.length, 0), 0),
    [groups]
  );

  return (
    <div className="relative">
      {!compact && <label className="text-[10px] text-muted-foreground uppercase font-bold block mb-1">{label}</label>}
      <Button
        variant="outline"
        size={compact ? "sm" : "default"}
        className={cn("w-full justify-between gap-2 bg-secondary/50 border-border/50", compact && "h-8 text-xs")}
        onClick={() => setOpen(!open)}
        disabled={loading || models.length === 0}
      >
        <div className="flex items-center gap-2 min-w-0">
          {loading
            ? <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-blue-400" />
            : <Bot className="w-3.5 h-3.5 shrink-0 text-blue-400" />}
          <span className="truncate">{modelLabel}</span>
        </div>
        <ChevronDown className={cn("w-3.5 h-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </Button>

      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-card border border-border/50 rounded-lg shadow-xl overflow-hidden">
          <div className="p-2 bg-secondary/30 flex items-center gap-2 sticky top-0">
            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Buscar modelo (ex: claude, gpt, flash)…"
              className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
            <Badge className="bg-green-500/10 text-green-400 border-none text-[8px] shrink-0">{query.trim() ? `${visibleCount}/${models.length}` : models.length}</Badge>
          </div>
          {error && (
            <div className="px-3 py-2 text-[10px] text-amber-300">⚠ {error} — admin configura API key em Configurações.</div>
          )}
          <div className="max-h-[300px] overflow-y-auto">
            {groups.length === 0 && !error && (
              <div className="px-3 py-3 text-[10px] text-muted-foreground">Nenhum modelo encontrado.</div>
            )}
            {groups.map(group => {
              const groupCount = group.subgroups.reduce((s, sg) => s + sg.items.length, 0);
              return (
              <div key={group.provider}>
                <div className="px-3 py-1.5 bg-secondary/40 sticky top-0 z-10">
                  <span className={cn(
                    "text-[10px] font-bold uppercase tracking-wider",
                    PROVIDER_COLOR[group.provider] || "text-blue-400"
                  )}>
                    {PROVIDER_LABEL[group.provider] || group.provider} · {groupCount}
                  </span>
                </div>
                {group.subgroups.map(sub => (
                  <div key={sub.label || "_"}>
                    {sub.label && (
                      <div className="px-3 py-1 bg-secondary/10 flex items-center gap-1.5">
                        <span className={cn(
                          "text-[9px] font-bold uppercase tracking-wider",
                          sub.label === "Grátis" ? "text-green-400" : "text-muted-foreground/80"
                        )}>
                          {sub.label === "Grátis" ? "★ Grátis" : sub.label} · {sub.items.length}
                        </span>
                      </div>
                    )}
                    {sub.items.map(model => {
                      const toolWarn = requireTools && model.supportsTools === false;
                      return (
                        <button
                          key={model.id}
                          className={cn(
                            "w-full px-3 py-2 text-left text-xs hover:bg-secondary/50 transition-colors",
                            value === model.id && "bg-primary/10 text-primary"
                          )}
                          onClick={() => { onChange(model.id); setOpen(false); setQuery(""); }}
                        >
                          <div className="font-mono flex items-center gap-1.5">
                            {model.rawId || model.id}
                            {requireTools && model.supportsTools && (
                              <Wrench className="w-3 h-3 text-green-400 shrink-0" />
                            )}
                          </div>
                          {model.name && model.name !== (model.rawId || model.id) && (
                            <div className="text-[10px] text-muted-foreground truncate">{model.name}</div>
                          )}
                          {toolWarn && (
                            <div className="text-[9px] text-amber-400">⚠ Sem suporte a ferramentas — o agente pode não agendar/buscar KB.</div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Renderiza <optgroup>/<option> agrupados por provedor + subgrupo (Grátis,
 * família) pra usar dentro de um <select> NATIVO. Centraliza o agrupamento dos
 * seletores inline das páginas, pra todos ficarem organizados igual ao dropdown.
 */
export function ModelOptions({ models, markNoTools = false }: { models: GroupableModel[]; markNoTools?: boolean }) {
  const groups = groupModels(models);
  return (
    <>
      {groups.map(group =>
        group.subgroups.map(sub => (
          <optgroup
            key={group.provider + "|" + (sub.label || "_")}
            label={`${PROVIDER_LABEL[group.provider] || group.provider}${sub.label ? " · " + (sub.label === "Grátis" ? "★ Grátis" : sub.label) : ""}`}
            className="bg-neutral-900"
          >
            {sub.items.map(m => {
              const raw = m.rawId || m.id;
              let label = m.name && m.name !== raw ? `${raw} — ${m.name}` : raw;
              if (markNoTools && m.supportsTools === false) label += " ⚠ sem ferramentas";
              return (
                <option key={m.id} value={m.id} className="bg-neutral-900 text-white">
                  {label}
                </option>
              );
            })}
          </optgroup>
        ))
      )}
    </>
  );
}

interface ModuleHeroProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  steps: { emoji: string; title: string; desc: string }[];
  connections?: string[];
  color: string;
}

export function ModuleHero({ icon, title, description, steps, connections, color }: ModuleHeroProps) {
  const [showGuide, setShowGuide] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {icon}
          <div>
            <h1 className="text-lg font-bold">{title}</h1>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        <Button variant="ghost" size="sm" className="text-xs gap-1.5 text-primary" onClick={() => setShowGuide(!showGuide)}>
          <Sparkles className="w-3.5 h-3.5" />
          {showGuide ? "Fechar guia" : "Como funciona?"}
        </Button>
      </div>

      {showGuide && (
        <div className={cn("rounded-xl border p-4 space-y-3 bg-gradient-to-br animate-in fade-in slide-in-from-top-2 duration-300", color)}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {steps.map((step, i) => (
              <div key={i} className="bg-black/20 backdrop-blur-sm rounded-lg p-3">
                <div className="text-lg mb-1">{step.emoji}</div>
                <p className="text-xs font-bold text-foreground">{step.title}</p>
                <p className="text-[10px] text-foreground/70 mt-0.5">{step.desc}</p>
              </div>
            ))}
          </div>
          {connections && connections.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] text-foreground/60 font-bold uppercase">Conecta com:</span>
              {connections.map(c => (
                <Badge key={c} variant="secondary" className="text-[9px] bg-black/20 border-white/10">{c}</Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
