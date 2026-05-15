"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Trash2, X } from "lucide-react";
import { Toggle } from "./toggle";

export type Stage = {
  id: string;
  title: string;
  goal_prompt: string;
  condition_variable?: string | null;
  condition_operator?: string | null;
  condition_value?: string | null;
  captured_variables?: Array<{ name: string; description: string; type: string }>;
};

export function SortableStage({
  stage,
  idx,
  stages,
  setStages,
  deletarStage,
  onSaveStage,
}: {
  stage: Stage;
  idx: number;
  stages: Stage[];
  setStages: (s: Stage[]) => void;
  deletarStage: (id: string) => void;
  onSaveStage: (stage: Stage) => Promise<void>;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: stage.id });
  const style = { transform: CSS.Transform.toString(transform), transition };

  const updateStage = (patch: Partial<Stage>) => {
    setStages(stages.map((s) => (s.id === stage.id ? { ...s, ...patch } : s)));
  };

  const capturedVars = Array.isArray(stage.captured_variables) ? stage.captured_variables : [];

  const updateCapturedVar = (vIdx: number, patch: Partial<Stage["captured_variables"] extends (infer U)[] | undefined ? U : never>) => {
    const next = [...capturedVars];
    next[vIdx] = { ...next[vIdx], ...patch } as any;
    updateStage({ captured_variables: next });
  };

  return (
    <div ref={setNodeRef} style={style} className="glass-card p-6 rounded-[2rem] border-white/10 space-y-4 bg-white/[0.02]">
      {/* Header: drag handle + title + delete */}
      <div className="flex items-center justify-between border-b border-white/5 pb-3">
        <div className="flex items-center gap-2">
          <div {...attributes} {...listeners} className="cursor-grab text-white/50 hover:text-white">
            <GripVertical className="w-5 h-5" />
          </div>
          <h4 className="font-bold">{idx + 1}. {stage.title}</h4>
        </div>
        <Button onClick={() => deletarStage(stage.id)} size="icon" variant="ghost" className="text-red-500 hover:bg-red-500/10">
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>

      {/* Instrução */}
      <div className="space-y-2">
        <label className="text-[10px] font-black uppercase tracking-widest text-primary">Instrução / O que o agente deve fazer</label>
        <Textarea
          value={stage.goal_prompt}
          onChange={(e) => updateStage({ goal_prompt: e.target.value })}
          className="bg-black/30 h-20 text-xs"
        />
      </div>

      {/* Condição */}
      <div className="space-y-3 p-4 bg-yellow-500/5 border border-yellow-500/20 rounded-xl">
        <div className="flex items-center justify-between mb-2">
          <label className="text-[10px] font-black uppercase tracking-widest text-yellow-400">Condição para executar</label>
          <div className="flex items-center gap-2">
            <Toggle
              checked={!!stage.condition_variable}
              onCheckedChange={(on) => {
                if (on) {
                  updateStage({ condition_variable: "variavel", condition_value: "valor", condition_operator: "equals" });
                } else {
                  updateStage({ condition_variable: null, condition_value: null });
                }
              }}
              color="yellow"
              size="sm"
              aria-label="Condição para executar"
            />
            <span className="text-[10px] uppercase text-white/50">{stage.condition_variable ? "Ativada" : "Desativada"}</span>
          </div>
        </div>

        {stage.condition_variable ? (
          <div className="grid grid-cols-3 gap-2">
            <Input
              placeholder="Variável (ex: forma_retirada)"
              value={stage.condition_variable || ""}
              onChange={(e) => updateStage({ condition_variable: e.target.value })}
              className="bg-black/50 border-white/10 text-xs h-9"
            />
            <select
              value={stage.condition_operator || "equals"}
              onChange={(e) => updateStage({ condition_operator: e.target.value })}
              className="bg-black/50 border border-white/10 text-white rounded-md text-xs px-2 h-9"
            >
              <option value="equals">Igual a</option>
              <option value="not_equals">Diferente de</option>
              <option value="contains">Contém</option>
            </select>
            <Input
              placeholder="Valor (ex: entrega)"
              value={stage.condition_value || ""}
              onChange={(e) => updateStage({ condition_value: e.target.value })}
              className="bg-black/50 border-white/10 text-xs h-9"
            />
          </div>
        ) : (
          <p className="text-xs text-white/40">Esta etapa será executada obrigatoriamente quando for a vez dela.</p>
        )}
      </div>

      {/* Capturar variáveis */}
      <div className="space-y-3 p-4 bg-blue-500/5 border border-blue-500/20 rounded-xl">
        <div className="flex items-center justify-between">
          <label className="text-[10px] font-black uppercase tracking-widest text-blue-400">Capturar variáveis</label>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => updateStage({ captured_variables: [...capturedVars, { name: "", description: "", type: "fixa" }] })}
            className="h-6 text-[10px] gap-1 text-blue-400 hover:text-blue-300 hover:bg-blue-400/10"
          >
            <Plus className="w-3 h-3" /> Adicionar variável
          </Button>
        </div>
        {capturedVars.map((v, vIdx) => (
          <div key={vIdx} className="flex gap-2 items-center">
            <Input
              placeholder="Nome (ex: nome)"
              value={v.name}
              onChange={(e) => updateCapturedVar(vIdx, { name: e.target.value })}
              className="bg-black/50 border-white/10 text-xs h-8 flex-1"
            />
            <Input
              placeholder="O que captar (ex: nome completo do lead)"
              value={v.description}
              onChange={(e) => updateCapturedVar(vIdx, { description: e.target.value })}
              className="bg-black/50 border-white/10 text-xs h-8 flex-1"
            />
            <select
              value={v.type || "fixa"}
              onChange={(e) => updateCapturedVar(vIdx, { type: e.target.value })}
              className="bg-black/50 border border-white/10 text-white rounded-md text-[10px] px-2 h-8 w-24"
            >
              <option value="fixa">Fixa</option>
              <option value="volatil">Volátil</option>
              <option value="reconfirmar">Reconfirmar</option>
            </select>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => updateStage({ captured_variables: capturedVars.filter((_, i) => i !== vIdx) })}
              className="h-8 w-8 text-red-400 hover:bg-red-500/10"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        ))}
      </div>

      <Button
        size="sm"
        onClick={() => onSaveStage(stage)}
        className="w-full h-8 text-[10px] bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20"
      >
        Salvar Alterações da Etapa
      </Button>
    </div>
  );
}
