"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Layers,
  Plus,
  Trash2,
  MoveUp,
  MoveDown,
  Sparkles,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  Zap,
  Play,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAiModels } from "@/hooks/use-ai-models";
import { ModelOptions } from "@/components/ai-module-shared";
import { type AiCombo, type AiComboStep, DEFAULT_AI_COMBOS } from "@/lib/ai-combos";
import { formatModelRef } from "@/lib/ai-provider";

export function AiCombosManager() {
  const { models } = useAiModels();
  const [combos, setCombos] = useState<AiCombo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Estado de teste de combo
  const [testingComboId, setTestingComboId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<any | null>(null);

  // Carrega combos salvos
  const loadCombos = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/ai-combos");
      const json = await res.json();
      if (json.success && Array.isArray(json.combos)) {
        setCombos(json.combos);
      } else {
        setCombos(DEFAULT_AI_COMBOS);
      }
    } catch {
      setCombos(DEFAULT_AI_COMBOS);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCombos();
  }, []);

  const handleSave = async (updated: AiCombo[]) => {
    setSaving(true);
    setSaveSuccess(false);
    try {
      const res = await fetch("/api/ai-combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ combos: updated }),
      });
      const json = await res.json();
      if (json.success) {
        setCombos(json.combos);
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 3000);
      } else {
        alert(json.error || "Erro ao salvar combos.");
      }
    } catch (err) {
      console.error("Erro ao salvar combos:", err);
      alert("Erro ao salvar combos. Verifique o console.");
    } finally {
      setSaving(false);
    }
  };

  const handleAddCombo = () => {
    const newId = `combo_${Date.now()}`;
    const newCombo: AiCombo = {
      id: newId,
      name: "Novo Combo Resiliente",
      description: "Cascata de modelos customizada",
      models: [
        { modelRef: "gateway:gemini-2.5-flash", label: "Gemini 2.5 Flash", enabled: true },
        { modelRef: "gemini-2.5-flash", label: "Gemini Flash (API Key)", enabled: true },
      ],
    };
    const next = [...combos, newCombo];
    setCombos(next);
    handleSave(next);
  };

  const handleDeleteCombo = (id: string) => {
    const combo = combos.find((c) => c.id === id);
    if (!confirm(`Excluir o combo "${combo?.name || id}"? Os agentes que o usam devem ser trocados de modelo.`)) return;
    const next = combos.filter((c) => c.id !== id);
    setCombos(next);
    handleSave(next);
  };

  const handleAddModelToCombo = (comboId: string, modelRef: string) => {
    if (!modelRef) return;
    const next = combos.map((c) => {
      if (c.id !== comboId) return c;
      const modelObj = models.find((m) => m.id === modelRef);
      const newStep: AiComboStep = {
        modelRef,
        label: modelObj?.name || modelRef,
        enabled: true,
      };
      return { ...c, models: [...c.models, newStep] };
    });
    setCombos(next);
    handleSave(next);
  };

  const handleRemoveModelFromCombo = (comboId: string, stepIndex: number) => {
    const next = combos.map((c) => {
      if (c.id !== comboId) return c;
      const updatedModels = c.models.filter((_, idx) => idx !== stepIndex);
      return { ...c, models: updatedModels };
    });
    setCombos(next);
    handleSave(next);
  };

  const handleMoveStep = (comboId: string, fromIndex: number, toIndex: number) => {
    const next = combos.map((c) => {
      if (c.id !== comboId) return c;
      const copy = [...c.models];
      const [moved] = copy.splice(fromIndex, 1);
      copy.splice(toIndex, 0, moved);
      return { ...c, models: copy };
    });
    setCombos(next);
    handleSave(next);
  };

  const handleToggleStep = (comboId: string, stepIndex: number) => {
    const next = combos.map((c) => {
      if (c.id !== comboId) return c;
      const copy = [...c.models];
      copy[stepIndex] = { ...copy[stepIndex], enabled: !copy[stepIndex].enabled };
      return { ...c, models: copy };
    });
    setCombos(next);
    handleSave(next);
  };

  const handleTestCombo = async (comboId: string) => {
    setTestingComboId(comboId);
    setTestResult(null);
    try {
      const res = await fetch("/api/ai-combos/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comboId }),
      });
      const json = await res.json();
      setTestResult({ comboId, data: json });
    } catch (err: any) {
      setTestResult({ comboId, data: { success: false, error: err?.message || "Erro no teste" } });
    } finally {
      setTestingComboId(null);
    }
  };

  // Filtra modelos elegíveis para serem adicionados num combo (exclui outros combos)
  const availableModels = models.filter((m: any) => m.provider !== "combo");

  return (
    <Card className="border-amber-500/20 bg-gradient-to-b from-amber-500/[0.04] to-card/60 shadow-lg">
      <CardHeader className="pb-3 border-b border-border/50">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                ⚡ Combos Virtuais de IA (Fallback & Rotação 9Router-Style)
                <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-400 border-amber-500/30 font-mono">
                  Multi-Account & Auto-Cascade
                </Badge>
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Crie filas inteligentes com prioridade de modelos e rotação automática de contas. Se um modelo falhar ou esgotar quota (429/5xx/timeout), o sistema aciona o próximo instantaneamente.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {saveSuccess && (
              <span className="flex items-center gap-1 text-[11px] text-green-400 font-medium">
                <Check className="w-3.5 h-3.5" />
                Salvo
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={loadCombos}
              disabled={loading}
              className="text-xs h-8 gap-1.5"
            >
              <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
              Atualizar
            </Button>
            <Button
              size="sm"
              onClick={handleAddCombo}
              disabled={saving}
              className="bg-amber-500 hover:bg-amber-600 text-black font-semibold text-xs h-8 gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              Novo Combo
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-4 space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-10 gap-2 text-muted-foreground text-xs">
            <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
            Carregando combos de inteligência artificial...
          </div>
        ) : (
          <div className="space-y-4">
            {combos.map((combo) => (
              <div
                key={combo.id}
                className="rounded-xl border border-border/70 bg-card/40 p-4 space-y-3 relative group"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-foreground">{combo.name}</span>
                      <code className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                        combo:{combo.id}
                      </code>
                    </div>
                    {combo.description && (
                      <p className="text-xs text-muted-foreground">{combo.description}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleTestCombo(combo.id)}
                      disabled={testingComboId === combo.id}
                      className="text-xs h-7 gap-1 border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
                    >
                      {testingComboId === combo.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Play className="w-3 h-3" />
                      )}
                      Testar Cascata
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteCombo(combo.id)}
                      className="text-xs h-7 text-red-400 hover:bg-red-500/10"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>

                {/* Lista Ordenada de Modelos na Fila */}
                <div className="space-y-1.5 pt-1">
                  <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider flex items-center justify-between">
                    <span>Ordem de Prioridade na Fila ({combo.models.length} modelos)</span>
                    <span className="text-[9px] text-muted-foreground lowercase">Tenta todas as contas do 1º antes do 2º</span>
                  </div>

                  <div className="space-y-1">
                    {combo.models.map((step, idx) => (
                      <div
                        key={`${step.modelRef}_${idx}`}
                        className={cn(
                          "flex items-center justify-between p-2 rounded-lg border text-xs gap-2 transition-all",
                          step.enabled !== false
                            ? "bg-secondary/40 border-border/60"
                            : "bg-secondary/10 border-border/20 opacity-50"
                        )}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="w-5 h-5 rounded-full bg-amber-500/20 text-amber-300 font-bold text-[10px] flex items-center justify-center shrink-0">
                            {idx + 1}
                          </span>
                          <span className="font-mono text-xs truncate">{step.modelRef}</span>
                          {step.label && step.label !== step.modelRef && (
                            <span className="text-[10px] text-muted-foreground truncate">({step.label})</span>
                          )}
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={idx === 0}
                            onClick={() => handleMoveStep(combo.id, idx, idx - 1)}
                            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                          >
                            <MoveUp className="w-3 h-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={idx === combo.models.length - 1}
                            onClick={() => handleMoveStep(combo.id, idx, idx + 1)}
                            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                          >
                            <MoveDown className="w-3 h-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleToggleStep(combo.id, idx)}
                            className={cn(
                              "h-6 px-1.5 text-[10px]",
                              step.enabled !== false ? "text-green-400" : "text-muted-foreground"
                            )}
                          >
                            {step.enabled !== false ? "Ativo" : "Pausado"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveModelFromCombo(combo.id, idx)}
                            className="h-6 w-6 p-0 text-red-400 hover:text-red-300"
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Adicionar Modelo ao Combo */}
                <div className="flex items-center gap-2 pt-1">
                  <select
                    className="flex-1 h-8 rounded-lg bg-secondary/50 border border-border/60 text-xs px-2 text-foreground outline-none"
                    onChange={(e) => {
                      if (e.target.value) {
                        handleAddModelToCombo(combo.id, e.target.value);
                        e.target.value = "";
                      }
                    }}
                    defaultValue=""
                  >
                    <option value="" disabled>+ Adicionar modelo substituto a este combo...</option>
                    <ModelOptions models={availableModels} />
                  </select>
                </div>

                {/* Feedback de Teste de Cascata */}
                {testResult?.comboId === combo.id && (
                  <div className="mt-2 p-3 rounded-lg bg-secondary/70 border border-border/80 text-xs space-y-2">
                    <div className="flex items-center justify-between font-bold">
                      <span className="flex items-center gap-1.5">
                        {testResult.data.success ? (
                          <CheckCircle2 className="w-4 h-4 text-green-400" />
                        ) : (
                          <XCircle className="w-4 h-4 text-red-400" />
                        )}
                        {testResult.data.success ? "Cascata Resiliente Executada com Sucesso" : "Falha na Cascata"}
                      </span>
                      {testResult.data.totalDurationMs && (
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {testResult.data.totalDurationMs}ms
                        </span>
                      )}
                    </div>

                    {testResult.data.finalModelUsed && (
                      <div className="text-[11px] text-muted-foreground">
                        Modelo que respondeu: <strong className="text-foreground">{testResult.data.finalModelUsed}</strong>
                      </div>
                    )}

                    <div className="space-y-1">
                      {testResult.data.steps?.map((st: any) => (
                        <div key={st.step} className="flex items-center justify-between text-[11px] bg-background/50 p-1.5 rounded">
                          <span className="font-mono">{st.step}. {st.modelRef}</span>
                          <span className={cn(
                            "font-bold text-[10px]",
                            st.status === "success" ? "text-green-400" : "text-amber-400"
                          )}>
                            {st.status === "success" ? `✓ OK (${st.latencyMs}ms)` : `✗ ${st.error}`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
