"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Bot, ChevronDown, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";

export interface AIProvider {
  id: string;
  name: string;
  models: { id: string; label: string; speed: string }[];
  color: string;
  connected: boolean;
}

export const AI_PROVIDERS: AIProvider[] = [
  {
    id: "gemini",
    name: "Google Gemini",
    models: [
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", speed: "⚡ Rápido" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", speed: "🧠 Avançado" },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", speed: "⚡ Rápido" },
    ],
    color: "text-blue-400",
    connected: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    models: [
      { id: "gpt-4o", label: "GPT-4o", speed: "🧠 Avançado" },
      { id: "gpt-4o-mini", label: "GPT-4o Mini", speed: "⚡ Rápido" },
      { id: "gpt-4.1-mini", label: "GPT-4.1 Mini", speed: "⚡ Rápido" },
    ],
    color: "text-green-400",
    connected: false,
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    models: [
      { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4", speed: "🧠 Avançado" },
      { id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku", speed: "⚡ Rápido" },
    ],
    color: "text-purple-400",
    connected: false,
  },
];

interface AIModelSelectProps {
  value: string;
  onChange: (model: string) => void;
  label?: string;
  compact?: boolean;
}

export function AIModelSelect({ value, onChange, label = "Modelo IA", compact = false }: AIModelSelectProps) {
  const [open, setOpen] = useState(false);

  const currentModel = AI_PROVIDERS.flatMap(p => p.models.map(m => ({ ...m, provider: p }))).find(m => m.id === value);
  const providerName = currentModel?.provider.name || "Gemini";
  const modelLabel = currentModel?.label || value;

  return (
    <div className="relative">
      {!compact && <label className="text-[10px] text-muted-foreground uppercase font-bold block mb-1">{label}</label>}
      <Button
        variant="outline"
        size={compact ? "sm" : "default"}
        className={cn("w-full justify-between gap-2 bg-secondary/50 border-border/50", compact && "h-8 text-xs")}
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Bot className={cn("w-3.5 h-3.5 shrink-0", currentModel?.provider.color || "text-blue-400")} />
          <span className="truncate">{compact ? modelLabel : `${providerName} — ${modelLabel}`}</span>
        </div>
        <ChevronDown className={cn("w-3.5 h-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </Button>

      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-card border border-border/50 rounded-lg shadow-xl overflow-hidden max-h-[280px] overflow-y-auto">
          {AI_PROVIDERS.map(provider => (
            <div key={provider.id}>
              <div className="px-3 py-2 bg-secondary/30 flex items-center justify-between">
                <span className={cn("text-[10px] font-bold uppercase tracking-wider", provider.color)}>{provider.name}</span>
                {provider.connected ? (
                  <Badge className="bg-green-500/10 text-green-400 border-none text-[8px]">Conectado</Badge>
                ) : (
                  <Badge variant="secondary" className="text-[8px]">Configurar em Ajustes</Badge>
                )}
              </div>
              {provider.models.map(model => (
                <button
                  key={model.id}
                  className={cn(
                    "w-full px-3 py-2 text-left text-xs hover:bg-secondary/50 transition-colors flex items-center justify-between",
                    value === model.id && "bg-primary/10 text-primary"
                  )}
                  onClick={() => { onChange(model.id); setOpen(false); }}
                >
                  <span>{model.label}</span>
                  <span className="text-[10px] text-muted-foreground">{model.speed}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
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
