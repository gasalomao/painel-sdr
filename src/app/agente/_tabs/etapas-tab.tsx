"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { SortableStage, type Stage } from "../_components/sortable-stage";
import { SaveButton } from "../_components/save-button";
import { EmptyState } from "../_components/empty-state";
import { ListTree, Plus } from "lucide-react";

export function EtapasTab({
  stages,
  setStages,
  showNovoStage,
  setShowNovoStage,
  novoStageTitle,
  setNovoStageTitle,
  novoStagePrompt,
  setNovoStagePrompt,
  onCreateStage,
  onDeleteStage,
  onReorder,
  onSaveStage,
}: {
  stages: Stage[];
  setStages: (s: Stage[]) => void;
  showNovoStage: boolean;
  setShowNovoStage: (v: boolean) => void;
  novoStageTitle: string;
  setNovoStageTitle: (v: string) => void;
  novoStagePrompt: string;
  setNovoStagePrompt: (v: string) => void;
  onCreateStage: () => void;
  onDeleteStage: (sid: string) => void;
  onReorder: (newStages: Stage[]) => Promise<void>;
  onSaveStage: (stage: Stage) => Promise<void>;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = async (event: any) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = stages.findIndex((s) => s.id === active.id);
      const newIndex = stages.findIndex((s) => s.id === over.id);
      const newStages = arrayMove(stages, oldIndex, newIndex);
      setStages(newStages);
      await onReorder(newStages);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-primary/15 text-primary shrink-0">
            <ListTree className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">Etapas do funil</h3>
            <p className="text-xs text-muted-foreground mt-0.5 max-w-2xl leading-relaxed">
              Defina os passos que a IA segue para qualificar o lead (ex.:{" "}
              <em>apresentação → entender dor → propor solução → agendar</em>). Arraste para reordenar.
            </p>
          </div>
        </div>
        <Button
          onClick={() => setShowNovoStage(!showNovoStage)}
          className="h-10 px-4 font-medium text-sm gap-2 rounded-xl"
        >
          <Plus className="w-4 h-4" /> Nova etapa
        </Button>
      </header>

      {showNovoStage && (
        <div className="border border-white/[0.08] bg-card/80 rounded-xl shadow-none p-5 space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Nome da etapa</label>
            <Input
              value={novoStageTitle}
              onChange={(e) => setNovoStageTitle(e.target.value)}
              placeholder="Ex.: Apresentação, Qualificação, Fechamento..."
              className="bg-white/[0.02] border-white/[0.08]"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Instrução para a IA</label>
            <p className="text-xs text-muted-foreground">O que a IA deve fazer nesta etapa.</p>
            <Textarea
              value={novoStagePrompt}
              onChange={(e) => setNovoStagePrompt(e.target.value)}
              placeholder="Ex.: Pergunte qual o principal desafio do cliente hoje na área dele."
              className="bg-white/[0.02] border-white/[0.08] h-24"
            />
          </div>
          <SaveButton label="Salvar etapa" onSave={onCreateStage} />
        </div>
      )}

      {!showNovoStage && stages.length === 0 && (
        <EmptyState
          icon={ListTree}
          title="Sem etapas no funil"
          description={
            <>
              Sem etapas, a IA apenas conversa livremente. Adicione etapas para{" "}
              <strong>guiar o cliente pelo funil</strong> — a IA cumpre o objetivo de cada etapa antes de avançar.
            </>
          }
          action={
            <Button
              onClick={() => setShowNovoStage(true)}
              className="h-10 px-4 font-medium text-sm gap-2 rounded-xl"
            >
              <Plus className="w-4 h-4" /> Criar primeira etapa
            </Button>
          }
        />
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={stages.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <div className="grid grid-cols-1 gap-4">
            {stages.map((stage, idx) => (
              <SortableStage
                key={stage.id}
                stage={stage}
                idx={idx}
                stages={stages}
                setStages={setStages}
                deletarStage={onDeleteStage}
                onSaveStage={onSaveStage}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}