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
      <div className="flex items-center justify-between">
        <h3 className="text-2xl font-black text-white">Etapas do Funil</h3>
        <Button onClick={() => setShowNovoStage(!showNovoStage)} className="glow-primary h-11 px-6 font-bold text-xs">
          Nova Etapa
        </Button>
      </div>

      {showNovoStage && (
        <div className="p-6 bg-white/5 border border-white/10 rounded-[2rem] space-y-4">
          <Input
            value={novoStageTitle}
            onChange={(e) => setNovoStageTitle(e.target.value)}
            placeholder="Título da Etapa"
            className="bg-black/50 border-white/10"
          />
          <Textarea
            value={novoStagePrompt}
            onChange={(e) => setNovoStagePrompt(e.target.value)}
            placeholder="Instrução..."
            className="bg-black/50 border-white/10 h-24"
          />
          <Button onClick={onCreateStage} className="glow-primary w-full">Salvar Etapa</Button>
        </div>
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
