"use client";

import { useEffect, useState } from "react";
import { Sparkles, RotateCcw, Clock, Bot, CheckCircle2, Info } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { toast } from "sonner";
import { useAiModels } from "@/hooks/use-ai-models";
import { RadixModelOptions, formatModelLabel } from "@/components/ai-module-shared";
import { cn } from "@/lib/utils";
import {
  DEFAULT_GOAL_TASK_CONFIG,
  DEFAULT_GOAL_TASK_PROMPT,
  type GoalTaskDeadlineUnit,
} from "@/types/goal-task-trigger";

const DEADLINE_UNIT_LABELS: Record<GoalTaskDeadlineUnit, string> = {
  business_days: "Dias úteis (pula fins de semana)",
  days: "Dias corridos",
  hours: "Horas",
};

interface DashboardGoalTriggerDialogProps {
  disabled?: boolean;
}

export function DashboardGoalTriggerDialog({ disabled }: DashboardGoalTriggerDialogProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [enabled, setEnabled] = useState(DEFAULT_GOAL_TASK_CONFIG.enabled);
  const [deadlineValue, setDeadlineValue] = useState(DEFAULT_GOAL_TASK_CONFIG.deadline_value);
  const [deadlineUnit, setDeadlineUnit] = useState<GoalTaskDeadlineUnit>(DEFAULT_GOAL_TASK_CONFIG.deadline_unit);
  const [model, setModel] = useState(DEFAULT_GOAL_TASK_CONFIG.model);
  const [prompt, setPrompt] = useState(DEFAULT_GOAL_TASK_CONFIG.prompt);

  const { models } = useAiModels();

  const selectedModelObj = models.find((m) => m.id === model);
  const modelDisplayLabel =
    !model || model === "_default"
      ? "Padrão do Sistema / Agente ativo"
      : selectedModelObj
      ? formatModelLabel(selectedModelObj)
      : model;

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);

    fetch("/api/tasks/goal-trigger", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!active) return;
        if (data?.ok && data?.config) {
          setEnabled(Boolean(data.config.enabled));
          setDeadlineValue(Number(data.config.deadline_value) || 2);
          setDeadlineUnit(data.config.deadline_unit || "business_days");
          setModel(data.config.model || "");
          setPrompt(data.config.prompt || DEFAULT_GOAL_TASK_PROMPT);
        }
      })
      .catch((err) => {
        if (!active) return;
        console.warn("[GOAL_TRIGGER] Erro ao carregar config:", err);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [open]);

  const handleResetPrompt = () => {
    setPrompt(DEFAULT_GOAL_TASK_PROMPT);
    toast.info("Prompt padrão restaurado.");
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/tasks/goal-trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          deadline_value: Math.max(1, Math.floor(deadlineValue)),
          deadline_unit: deadlineUnit,
          model,
          prompt,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Erro ao salvar configuração.");
      }

      toast.success("Gatilho de tarefas por IA atualizado com sucesso!");
      setOpen(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Erro ao salvar";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const deadlineDescription = () => {
    if (deadlineUnit === "business_days") {
      return `${deadlineValue} dia(s) útil(eis) — sábados e domingos são ignorados no cálculo.`;
    }
    if (deadlineUnit === "days") {
      return `${deadlineValue} dia(s) corridos a partir do momento em que o lead aceita.`;
    }
    return `${deadlineValue} hora(s) corridas a partir do momento em que o lead aceita.`;
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="min-h-11 gap-1.5 px-3 border-border/80 text-xs font-normal text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
        title="Configurar geração automática de tarefas quando o agente cumprir o objetivo"
      >
        <Sparkles className="size-3.5 text-primary" aria-hidden="true" />
        Gatilho IA
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className={cn(
            "max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl md:max-w-2xl",
            "bg-[#0e0f12] text-white border border-white/10 rounded-2xl shadow-2xl p-6",
            "[color-scheme:dark] [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.2)_transparent]",
            "[&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-white/20 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-white/30"
          )}
        >
          <DialogHeader className="pb-2">
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/30 bg-primary/10 text-primary shadow-inner">
                <Sparkles className="size-5 text-primary" aria-hidden="true" />
              </div>
              <div>
                <DialogTitle className="text-lg font-bold text-white tracking-tight">
                  Gatilho de Tarefas por IA
                </DialogTitle>
                <DialogDescription className="text-xs text-zinc-300 font-normal mt-1 leading-relaxed">
                  Cria tarefas automaticamente no Dashboard assim que o Agente SDR alcança o objetivo com o lead.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {loading ? (
            <div className="py-16 text-center text-sm text-zinc-300">
              Carregando configurações...
            </div>
          ) : (
            <div className="space-y-4 py-1">
              {/* Card de Ativação */}
              <div className="flex items-center justify-between rounded-xl border border-white/[0.08] bg-[#16171b] p-4 sm:p-5 shadow-sm transition-colors">
                <div className="space-y-1.5 pr-4">
                  <div className="flex items-center gap-2.5">
                    <span className="text-sm font-semibold text-white">
                      Criação automática de tarefa
                    </span>
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold border transition-colors",
                        enabled
                          ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                          : "border-zinc-700 bg-zinc-800 text-zinc-300"
                      )}
                    >
                      {enabled ? "Ativo" : "Inativo"}
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed text-zinc-300">
                    Gera e agenda uma tarefa executiva na Dashboard sempre que o Agente atingir o objetivo (ex: Sarah conseguir o aceite da prévia do site).
                  </p>
                </div>
                <Switch
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  aria-label="Ativar gatilho de tarefa"
                  className="data-[state=checked]:bg-emerald-500"
                />
              </div>

              {/* Configuração de SLA / Prazo */}
              <div className="space-y-3 rounded-xl border border-white/[0.08] bg-[#16171b] p-4 sm:p-5 shadow-sm">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-white">
                    <Clock className="size-4 text-primary" aria-hidden="true" />
                    <span>Prazo de entrega da demanda (SLA)</span>
                  </div>
                  <p className="text-xs text-zinc-300 mt-1 leading-relaxed">
                    Define a data e hora de vencimento calculada a partir do momento em que o lead aceita a proposta.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 pt-1">
                  <div className="space-y-1.5">
                    <label
                      htmlFor="goal-deadline-value"
                      className="text-xs font-semibold text-zinc-200 block"
                    >
                      Quantidade
                    </label>
                    <input
                      id="goal-deadline-value"
                      type="number"
                      min={1}
                      max={365}
                      value={deadlineValue}
                      onChange={(e) => setDeadlineValue(Math.max(1, Number(e.target.value) || 1))}
                      className="h-10 w-full rounded-lg border border-white/10 bg-[#1c1d22] px-3.5 text-sm text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus:border-primary transition-colors"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label
                      htmlFor="goal-deadline-unit"
                      className="text-xs font-semibold text-zinc-200 block"
                    >
                      Unidade de tempo
                    </label>
                    <Select
                      value={deadlineUnit}
                      onValueChange={(val) => setDeadlineUnit((val || "business_days") as GoalTaskDeadlineUnit)}
                    >
                      <SelectTrigger
                        id="goal-deadline-unit"
                        className="h-10 w-full rounded-lg border border-white/10 bg-[#1c1d22] px-3.5 text-sm text-white hover:border-white/20 focus-visible:ring-2 focus-visible:ring-primary/40 focus:border-primary transition-colors cursor-pointer"
                      >
                        <span className="flex-1 text-left truncate text-white">
                          {DEADLINE_UNIT_LABELS[deadlineUnit] || "Dias úteis (pula fins de semana)"}
                        </span>
                      </SelectTrigger>
                      <SelectContent className="bg-[#16171b] border border-white/15 text-white shadow-2xl rounded-xl p-1.5 [color-scheme:dark]">
                        <SelectItem value="business_days" className="text-sm py-2 px-3 rounded-lg hover:bg-white/10 cursor-pointer">
                          Dias úteis (pula fins de semana)
                        </SelectItem>
                        <SelectItem value="days" className="text-sm py-2 px-3 rounded-lg hover:bg-white/10 cursor-pointer">
                          Dias corridos
                        </SelectItem>
                        <SelectItem value="hours" className="text-sm py-2 px-3 rounded-lg hover:bg-white/10 cursor-pointer">
                          Horas
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="rounded-lg border border-primary/25 bg-primary/10 px-3.5 py-2.5 text-xs text-zinc-200 flex items-center gap-2.5">
                  <CheckCircle2 className="size-4 shrink-0 text-primary" aria-hidden="true" />
                  <span>
                    <strong className="text-white">Regra ativa:</strong> {deadlineDescription()}
                  </span>
                </div>
              </div>

              {/* Seletor de Modelo de IA */}
              <div className="space-y-3 rounded-xl border border-white/[0.08] bg-[#16171b] p-4 sm:p-5 shadow-sm">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-white">
                    <Bot className="size-4 text-primary" aria-hidden="true" />
                    <span>Modelo de IA para redigir a tarefa</span>
                  </div>
                  <p className="text-xs text-zinc-300 mt-1 leading-relaxed">
                    A IA analisará a conversa recente do lead para resumir exatamente o que deve ser feito.
                  </p>
                </div>

                <Select
                  value={model || "_default"}
                  onValueChange={(val) => setModel(val === "_default" ? "" : val || "")}
                >
                  <SelectTrigger
                    id="goal-model-select"
                    className="h-10 w-full rounded-lg border border-white/10 bg-[#1c1d22] px-3.5 text-sm text-white hover:border-white/20 focus-visible:ring-2 focus-visible:ring-primary/40 focus:border-primary transition-colors cursor-pointer"
                  >
                    <span className="flex-1 text-left truncate text-white">
                      {modelDisplayLabel}
                    </span>
                  </SelectTrigger>
                  <SelectContent className="max-h-[45vh] bg-[#16171b] border border-white/15 text-white shadow-2xl rounded-xl p-1.5 [color-scheme:dark]">
                    <SelectItem value="_default" className="text-xs py-2 px-3 rounded-lg hover:bg-white/10 cursor-pointer">
                      <span className="text-zinc-300 italic">Padrão do Sistema / Agente ativo</span>
                    </SelectItem>
                    <RadixModelOptions models={models} />
                  </SelectContent>
                </Select>
              </div>

              {/* Prompt de Instrução */}
              <div className="space-y-3 rounded-xl border border-white/[0.08] bg-[#16171b] p-4 sm:p-5 shadow-sm">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="goal-prompt-textarea"
                    className="text-sm font-semibold text-white"
                  >
                    Prompt de instrução para a IA
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleResetPrompt}
                    className="h-7 gap-1.5 px-2.5 text-xs text-zinc-300 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                  >
                    <RotateCcw className="size-3.5" aria-hidden="true" />
                    Restaurar padrão
                  </Button>
                </div>
                <p className="text-xs text-zinc-300 leading-relaxed">
                  Orienta a IA sobre como sintetizar os pontos combinados no WhatsApp em uma tarefa executiva.
                </p>
                <textarea
                  id="goal-prompt-textarea"
                  rows={4}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-[#1c1d22] px-3.5 py-3 text-xs leading-relaxed text-zinc-100 placeholder:text-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus:border-primary resize-y font-sans transition-colors"
                />
              </div>

              {/* Nota de rodapé explicativa */}
              <div className="flex items-start gap-2.5 rounded-xl border border-white/[0.08] bg-[#16171b]/60 p-3.5 text-xs text-zinc-300 leading-relaxed">
                <Info className="size-4 shrink-0 text-primary mt-0.5" aria-hidden="true" />
                <span>
                  As tarefas geradas aparecem diretamente aqui na sua lista de{" "}
                  <strong className="text-white">Tarefas e lembretes</strong>, com prazo e atalho para o lead correspondente.
                </span>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0 pt-3 border-t border-white/10">
            <Button
              variant="outline"
              className="min-h-10 px-4 text-xs font-medium border-white/15 text-zinc-300 hover:text-white hover:bg-white/10 rounded-lg"
              disabled={saving}
              onClick={() => setOpen(false)}
            >
              Cancelar
            </Button>
            <Button
              className="min-h-10 px-5 text-xs font-semibold rounded-lg shadow-sm"
              disabled={loading || saving}
              onClick={handleSave}
            >
              {saving ? "Salvando..." : "Salvar Configuração"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
