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
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-2xl font-black text-white">Etapas do Funil</h3>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            Defina os passos que a IA segue pra qualificar o lead — ex: <em>apresentação → entender dor → propor solução → agendar</em>.
            Arraste pra reordenar.
          </p>
        </div>
        <Button onClick={() => setShowNovoStage(!showNovoStage)} className="glow-primary h-11 px-6 font-bold text-xs uppercase tracking-widest gap-2">
          <Plus className="w-4 h-4" /> Nova Etapa
        </Button>
      </div>

      {showNovoStage && (
        <div className="p-6 bg-white/5 border border-white/10 rounded-[2rem] space-y-4">
          <div className="space-y-1.5">
            <label className="text-[10px] font-black uppercase tracking-widest text-primary">Título da Etapa</label>
            <Input
              value={novoStageTitle}
              onChange={(e) => setNovoStageTitle(e.target.value)}
              placeholder="Ex: Apresentação, Qualificação, Fechamento..."
              className="bg-black/50 border-white/10"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] font-black uppercase tracking-widest text-primary">Instrução pra IA nessa etapa</label>
            <Textarea
              value={novoStagePrompt}
              onChange={(e) => setNovoStagePrompt(e.target.value)}
              placeholder="O que a IA deve FAZER nessa etapa. Ex: 'Pergunte qual o principal desafio do cliente hoje na área X'."
              className="bg-black/50 border-white/10 h-24"
            />
          </div>
          <SaveButton label="Salvar Etapa" onSave={onCreateStage} />
        </div>
      )}

      {!showNovoStage && stages.length === 0 && (
        <EmptyState
          icon={ListTree}
          title="Sem etapas no funil"
          description={
            <>
              Sem etapas, a IA só conversa livre. Adicione etapas pra <strong>guiar o cliente num funil</strong> — ela vai cumprir o objetivo de cada etapa antes de avançar pra próxima.
            </>
          }
          action={
            <Button
              onClick={() => setShowNovoStage(true)}
              className="glow-primary h-10 px-5 font-bold text-xs uppercase tracking-widest gap-2"
            >
              <Plus className="w-4 h-4" /> Criar primeira etapa
            </Button>
          }
        />
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={stages.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <div className="grid grid-cols-1 gap-6">
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
