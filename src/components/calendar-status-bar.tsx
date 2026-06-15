"use client";

/**
 * Barra de status do /calendario: mostra de relance qual modelo IA está em uso,
 * qual agente está vinculado ao Google e a instância que dispara follow-ups.
 *
 * Regras:
 *   • Modelo IA: cliente comum só VÊ; admin pode TROCAR (mexe em
 *     ai_organizer_config global via PATCH /api/organizer/model).
 *   • Agente vinculado: o primeiro scheduler com Google conectado da conta.
 *   • Instância de follow-up: a instance_name vinculada ao agente acima
 *     (channel_connections.agent_id = X).
 *
 * Compacta em uma linha horizontal (3 cards) com a paleta padrão do painel.
 */

import { useEffect, useState, useCallback } from "react";
import { Loader2, Bot, Smartphone, Sparkles, ChevronDown, CheckCircle2 } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Agent = {
  id: number;
  name: string;
  is_scheduler?: boolean;
  google_connected?: boolean;
};

type Instance = { instance_name: string; agent_id?: number | null; status?: string };
type ModelOpt = { id: string; name?: string };

export function CalendarStatusBar({
  agents,
  isAdmin,
  onModelChange,
}: {
  agents: Agent[];
  isAdmin: boolean;
  onModelChange?: (newModel: string) => void;
}) {
  const [currentModel, setCurrentModel] = useState<string>("");
  const [savingModel, setSavingModel] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelOpt[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);

  // Carrega modelo atual do organizer config + opções disponíveis
  useEffect(() => {
    fetch("/api/organizer", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        // GET /api/organizer devolve { ok, model } no nível raiz (não
        // { success, config.model }). Ler o shape errado fazia o modelo
        // aparecer VAZIO ao voltar pra página.
        if (d?.ok && d.model) setCurrentModel(d.model);
      })
      .catch(() => {});
    if (isAdmin) {
      fetch("/api/ai-models", { cache: "no-store" })
        .then(r => r.json())
        .then(d => {
          if (d?.success && Array.isArray(d.models)) setModelOptions(d.models);
        })
        .catch(() => {});
    }
  }, [isAdmin]);

  useEffect(() => {
    fetch("/api/instances", { cache: "no-store" })
      .then(r => r.json())
      .then(d => { if (d?.ok) setInstances(d.instances || []); })
      .catch(() => setInstances([]));
  }, []);

  // Agente "ativo" pro calendário = primeiro scheduler conectado, ou primeiro
  // is_scheduler, ou só o primeiro disponível.
  const primaryAgent =
    agents.find(a => a.is_scheduler && a.google_connected) ||
    agents.find(a => a.is_scheduler) ||
    agents[0] || null;

  // Instância vinculada a esse agente
  const primaryInstance =
    instances.find(i => primaryAgent && i.agent_id === primaryAgent.id) ||
    instances[0] || null;

  const saveModel = useCallback(async (newModel: string) => {
    if (!isAdmin || newModel === currentModel) return;
    setSavingModel(true);
    try {
      const r = await fetch("/api/organizer/model", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: newModel }),
      });
      const d = await r.json();
      if (r.ok && d.success !== false) {
        setCurrentModel(newModel);
        onModelChange?.(newModel);
      }
    } finally {
      setSavingModel(false);
    }
  }, [isAdmin, currentModel, onModelChange]);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
      {/* Card 1: Modelo IA */}
      <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-purple-500/[0.05] border border-purple-500/15">
        <div className="w-8 h-8 rounded-md bg-purple-500/15 flex items-center justify-center shrink-0">
          <Sparkles className="w-4 h-4 text-purple-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[9px] font-black uppercase tracking-widest text-purple-200/70">
            Modelo IA {!isAdmin && <span className="opacity-60">(somente leitura)</span>}
          </div>
          {isAdmin ? (
            <Select value={currentModel} onValueChange={(v) => saveModel(v || "")} disabled={savingModel}>
              <SelectTrigger className="h-6 px-1 py-0 border-0 bg-transparent text-xs font-mono font-bold text-purple-100 hover:bg-white/5 -ml-1 w-full">
                <SelectValue placeholder={savingModel ? "salvando…" : "—"} />
                {savingModel ? <Loader2 className="w-3 h-3 animate-spin ml-1" /> : <ChevronDown className="w-3 h-3 opacity-60" />}
              </SelectTrigger>
              <SelectContent className="max-h-[50vh]">
                {modelOptions.length === 0 ? (
                  <div className="text-[10px] text-muted-foreground px-2 py-1">Configure API Key Gemini</div>
                ) : modelOptions.map(m => (
                  <SelectItem key={m.id} value={m.id} className="text-xs">
                    {m.name || m.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="text-xs font-mono font-bold text-purple-100 truncate" title={currentModel}>
              {currentModel || "—"}
            </div>
          )}
        </div>
      </div>

      {/* Card 2: Agente vinculado */}
      <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-blue-500/[0.05] border border-blue-500/15">
        <div className="w-8 h-8 rounded-md bg-blue-500/15 flex items-center justify-center shrink-0">
          <Bot className="w-4 h-4 text-blue-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[9px] font-black uppercase tracking-widest text-blue-200/70 flex items-center gap-1">
            Agente vinculado
            {primaryAgent?.google_connected && (
              <CheckCircle2 className="w-2.5 h-2.5 text-emerald-400" />
            )}
          </div>
          <div className="text-xs font-bold text-blue-100 truncate" title={primaryAgent?.name || ""}>
            {primaryAgent?.name || <span className="text-muted-foreground/70 font-normal">Nenhum agente scheduler</span>}
          </div>
        </div>
      </div>

      {/* Card 3: Instância de envio */}
      <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-emerald-500/[0.05] border border-emerald-500/15">
        <div className="w-8 h-8 rounded-md bg-emerald-500/15 flex items-center justify-center shrink-0">
          <Smartphone className="w-4 h-4 text-emerald-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[9px] font-black uppercase tracking-widest text-emerald-200/70 flex items-center gap-1">
            Disparo follow-up
            {primaryInstance?.status === "open" && (
              <span className={cn("w-1 h-1 rounded-full bg-emerald-400 animate-pulse")} />
            )}
          </div>
          <div className="text-xs font-mono font-bold text-emerald-100 truncate" title={primaryInstance?.instance_name || ""}>
            {primaryInstance?.instance_name || <span className="text-muted-foreground/70 font-normal">Sem instância vinculada</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
