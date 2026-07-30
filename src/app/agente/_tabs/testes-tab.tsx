"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { greetingFor, renderTemplate, TEMPLATE_VARIABLES } from "@/lib/template-vars";
import {
  BookOpen,
  Bot,
  Calendar,
  Check,
  FlaskConical,
  Globe,
  Loader2,
  Plug,
  Send,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";
import { LeadSelectorUI, type PreviewLead, type PreviewSample } from "../_components/lead-selector";
import { Toggle } from "../_components/toggle";

type TestMessage = { role: "user" | "agent" | "tool"; content: string; isError?: boolean };

type ToolColor = "purple" | "blue" | "amber" | "gray";

function toolMeta(content: string): { label: string; color: ToolColor; Icon: React.ComponentType<{ className?: string }> } {
  if (/RAG|search_knowledge_base/i.test(content)) return { label: "Base de conhecimento", color: "purple", Icon: BookOpen };
  if (/Google Calendar|calendar/i.test(content)) return { label: "Google Calendar (MCP)", color: "blue", Icon: Calendar };
  if (/Webhook Custom/i.test(content)) return { label: "Tool customizada", color: "amber", Icon: Plug };
  return { label: "Tool", color: "gray", Icon: Wrench };
}

const TOOL_COLOR: Record<ToolColor, string> = {
  purple: "bg-purple-500/10 border-purple-500/20 text-purple-200",
  blue: "bg-blue-500/10 border-blue-500/20 text-blue-200",
  amber: "bg-amber-500/10 border-amber-500/20 text-amber-200",
  gray: "bg-white/5 border-white/[0.08] text-white/80",
};

function renderSandboxMessageContent(content: string) {
  if (!content) return null;
  const imageRegex = /(?:\[(?:IMAGEM|IMAGE|MEDIA|FOTO):\s*(https?:\/\/[^\s\]]+)\]|!\[[^\]]*\]\((https?:\/\/[^\s\)]+)\))/gi;
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(imageRegex.source, "gi");

  while ((match = re.exec(content)) !== null) {
    const textBefore = content.slice(lastIdx, match.index);
    if (textBefore) {
      parts.push(<span key={`text-${lastIdx}`}>{textBefore}</span>);
    }
    const imageUrl = (match[1] || match[2] || "").trim();
    if (imageUrl) {
      parts.push(
        <div key={`img-${match.index}`} className="my-2 space-y-1">
          <a href={imageUrl} target="_blank" rel="noreferrer" className="block">
            <img
              src={imageUrl}
              alt="Mídia enviada"
              className="rounded-lg border border-white/[0.08] max-h-56 max-w-full object-cover"
              onError={(e) => {
                (e.target as HTMLElement).style.display = "none";
              }}
            />
          </a>
          <span className="inline-flex items-center gap-1.5 text-[10px] text-emerald-300 bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/20">
            <span className="font-medium">Mídia enviada via WhatsApp</span>
          </span>
        </div>
      );
    }
    lastIdx = match.index + match[0].length;
  }

  const textAfter = content.slice(lastIdx);
  if (textAfter) {
    parts.push(<span key={`text-${lastIdx}`}>{textAfter}</span>);
  }

  if (parts.length === 0) {
    return content;
  }

  return <>{parts}</>;
}

export function TestesTab(props: {
  // Lead picker
  previewSample: PreviewSample;
  setPreviewSample: (s: PreviewSample) => void;
  previewLeads: PreviewLead[];
  previewLeadsLoading: boolean;
  loadPreviewLeads: () => void;
  previewSelectedLeadId: number | null;
  applyLeadToSample: (l: PreviewLead) => void;
  previewLeadQuery: string;
  setPreviewLeadQuery: (v: string) => void;

  // Sandbox: simulação inicial
  sandboxTemplate: string;
  setSandboxTemplate: (v: string) => void;
  sandboxPersonalizeAI: boolean;
  setSandboxPersonalizeAI: (v: boolean) => void;
  sandboxAiPrompt: string;
  setSandboxAiPrompt: (v: string) => void;
  sandboxUseWebSearch: boolean;
  setSandboxUseWebSearch: (v: boolean) => void;
  sandboxSimulating: boolean;
  sandboxSimulationEnabled: boolean;
  setSandboxSimulationEnabled: (v: boolean) => void;
  simulateInitialMessage: () => void;
  targetModel: string;

  // Chat
  nomeAgente: string;
  humanizeMessages: boolean;
  messageBufferSeconds: number;
  testMessages: TestMessage[];
  testInput: string;
  setTestInput: (v: string) => void;
  testLoading: boolean;
  handleTestSubmit: (e: React.FormEvent) => void;
  clearTestSession: () => void;

  // Timeline
  stages: any[];
  testStageIndex: number;
  testSkippedStages: number[];
  testVariables: Record<string, string>;
}) {
  const previewSandboxMessage = useMemo(
    () => renderTemplate(props.sandboxTemplate, props.previewSample as any),
    [props.sandboxTemplate, props.previewSample]
  );

  return (
    <div className="space-y-6">
      {/* ============= SIMULAÇÃO DE LEAD / DISPARO ============= */}
      <section className="border border-white/[0.08] bg-card/80 rounded-xl shadow-none p-6 space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-cyan-500/15 text-cyan-300 shrink-0">
              <FlaskConical className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-sm font-semibold text-foreground">Simulação de lead / disparo</h4>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                Escolha um lead para preencher as variáveis e simular a primeira mensagem.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2 px-3">
            <span className="text-xs font-medium text-foreground">
              {props.sandboxSimulationEnabled ? "Simulação ativa" : "Simulação pausada"}
            </span>
            <Toggle
              checked={props.sandboxSimulationEnabled}
              onCheckedChange={props.setSandboxSimulationEnabled}
              color="cyan"
              size="md"
              aria-label="Ativar/desativar Simulação de Lead"
            />
          </div>
        </div>

        <LeadSelectorUI
          sample={props.previewSample}
          setSample={props.setPreviewSample}
          leads={props.previewLeads}
          leadsLoading={props.previewLeadsLoading}
          selectedLeadId={props.previewSelectedLeadId}
          onSelectLead={props.applyLeadToSample}
          leadQuery={props.previewLeadQuery}
          setLeadQuery={props.setPreviewLeadQuery}
        />

        {props.previewLeads.length === 0 ? (
          <div className="text-center">
            <Button onClick={props.loadPreviewLeads} className="h-9 px-4 text-sm font-medium rounded-lg gap-2">
              Carregar leads
            </Button>
          </div>
        ) : (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 space-y-4">
            {/* Template */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Mensagem inicial (template)</label>

              <div className="flex flex-wrap gap-1.5">
                {TEMPLATE_VARIABLES.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    onClick={() => props.setSandboxTemplate(props.sandboxTemplate + `{{${v.key}}}`)}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", `{{${v.key}}}`)}
                    className="text-[10px] font-mono px-2 py-1 rounded-md bg-purple-500/10 border border-purple-500/20 text-purple-200 hover:bg-purple-500/15 transition-colors"
                    title={v.hint}
                  >
                    {`{{${v.key}}}`}
                  </button>
                ))}
              </div>

              <textarea
                value={props.sandboxTemplate}
                onChange={(e) => props.setSandboxTemplate(e.target.value)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const v = e.dataTransfer.getData("text/plain");
                  if (!v) return;
                  const ta = e.currentTarget;
                  const start = ta.selectionStart ?? props.sandboxTemplate.length;
                  const end = ta.selectionEnd ?? props.sandboxTemplate.length;
                  props.setSandboxTemplate(props.sandboxTemplate.slice(0, start) + v + props.sandboxTemplate.slice(end));
                }}
                className="w-full bg-white/[0.02] border border-white/[0.08] text-white font-mono text-xs p-3 rounded-lg min-h-[60px] focus:outline-none focus:border-cyan-500/40"
              />

              <div className="rounded-lg bg-emerald-500/5 border border-emerald-500/15 p-3">
                <p className="text-[10px] uppercase font-medium tracking-wide text-emerald-300 mb-1">
                  Pré-visualização
                </p>
                <p className="text-xs text-emerald-100/90 whitespace-pre-wrap font-mono">{previewSandboxMessage}</p>
                <p className="text-[10px] text-emerald-100/50 mt-2 italic">
                  Saudação atual: <strong>{greetingFor()}</strong>
                </p>
              </div>
            </div>

            {/* Personalizar com IA */}
            <div className="flex items-center justify-between gap-4 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
              <div className="flex items-center gap-2 min-w-0">
                <Sparkles className="w-4 h-4 text-purple-300 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">Personalizar com IA</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Reescreve a mensagem usando o modelo definido (
                    <span className="text-purple-200 font-mono">{props.targetModel || "padrão"}</span>).
                  </p>
                </div>
              </div>
              <Toggle
                checked={props.sandboxPersonalizeAI}
                onCheckedChange={props.setSandboxPersonalizeAI}
                color="purple"
                size="md"
                aria-label="Personalizar com IA"
              />
            </div>

            {/* Configurações da personalização IA */}
            {props.sandboxPersonalizeAI && (
              <div className="space-y-3 rounded-lg border border-purple-500/15 bg-purple-500/5 p-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Prompt da IA</label>
                  <textarea
                    value={props.sandboxAiPrompt}
                    onChange={(e) => props.setSandboxAiPrompt(e.target.value)}
                    className="w-full bg-white/[0.02] border border-purple-500/20 text-white text-xs p-3 rounded-lg min-h-[100px] focus:outline-none focus:border-purple-500/40"
                  />
                </div>
                <div className="flex items-center justify-between gap-4 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <Globe className="w-3.5 h-3.5 text-purple-300 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground">Usar Web Search</p>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        Permite à IA pesquisar na web informações da empresa do lead.
                      </p>
                    </div>
                  </div>
                  <Toggle
                    checked={props.sandboxUseWebSearch}
                    onCheckedChange={props.setSandboxUseWebSearch}
                    color="purple"
                    size="sm"
                    aria-label="Usar Web Search"
                  />
                </div>
              </div>
            )}

            <div className="flex justify-end pt-1">
              <Button
                onClick={props.simulateInitialMessage}
                disabled={props.sandboxSimulating || !props.previewSample.telefone || !props.sandboxSimulationEnabled}
                className="h-10 px-5 font-medium text-sm rounded-lg gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {props.sandboxSimulating ? (
                  <span className="flex items-center"><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Gerando mensagem...</span>
                ) : !props.sandboxSimulationEnabled ? (
                  <span className="flex items-center"><FlaskConical className="w-4 h-4 mr-2" /> Simulação pausada</span>
                ) : (
                  <span className="flex items-center"><Send className="w-4 h-4 mr-2" /> Disparar primeira mensagem</span>
                )}
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* ============= CHAT + TIMELINE ============= */}
      <div className="flex flex-col md:flex-row gap-4 h-[560px]">
        {/* Chat */}
        <div className="flex-1 border border-white/[0.08] bg-card/80 rounded-xl shadow-none overflow-hidden flex flex-col">
          <div className="px-4 py-3 flex items-center justify-between border-b border-white/[0.06] bg-white/[0.02]">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-primary/15 text-primary">
                <Bot className="w-4 h-4" />
              </div>
              <div>
                <h4 className="text-sm font-medium text-foreground">{props.nomeAgente || "Agente"} (Sandbox)</h4>
                <p className="text-[11px] text-muted-foreground">
                  Modelo: <span className="text-foreground/70 font-mono">{props.targetModel || "—"}</span>
                  {" · "}
                  {props.humanizeMessages ? "Mensagens quebradas: ON" : "Mensagens quebradas: OFF"}
                  {props.messageBufferSeconds > 0 && (
                    <span> · Buffer {props.messageBufferSeconds}s</span>
                  )}
                </p>
              </div>
            </div>
            <Button
              onClick={props.clearTestSession}
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground"
              title="Limpar conversa de teste"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {props.testMessages.length === 0 && (
              <div className="h-full flex items-center justify-center">
                <p className="text-xs text-muted-foreground text-center">
                  Dispare a primeira mensagem ou envie uma resposta abaixo para testar o agente.
                </p>
              </div>
            )}
            {props.testMessages.map((msg, i) => {
              if (msg.role === "tool") {
                const meta = toolMeta(msg.content);
                const { Icon } = meta;
                return (
                  <div key={i} className="flex justify-center">
                    <div className={cn("max-w-[90%] rounded-lg p-2.5 border text-[11px] font-mono leading-relaxed", TOOL_COLOR[meta.color])}>
                      <div className="flex items-center gap-1.5 mb-1">
                        <Icon className="w-3.5 h-3.5" />
                        <span className="text-[10px] font-medium uppercase tracking-wide opacity-80">{meta.label}</span>
                      </div>
                      <div className="opacity-90">{msg.content}</div>
                    </div>
                  </div>
                );
              }
              return (
                <div key={i} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                  <div
                    className={cn(
                      "max-w-[85%] text-sm p-3 rounded-2xl whitespace-pre-wrap",
                      msg.role === "user"
                        ? "bg-[#005c4b] text-white rounded-br-md"
                        : msg.isError
                          ? "bg-red-500/15 border border-red-500/30 text-red-200 rounded-bl-md"
                          : "bg-white/[0.06] text-foreground rounded-bl-md"
                    )}
                  >
                    {renderSandboxMessageContent(msg.content)}
                  </div>
                </div>
              );
            })}
            {props.testLoading && (
              <div className="flex items-center gap-2 pl-2 text-xs text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Digitando...
              </div>
            )}
          </div>

          <form onSubmit={props.handleTestSubmit} className="flex gap-2 p-3 border-t border-white/[0.06] bg-white/[0.02]">
            <Input
              value={props.testInput}
              onChange={(e) => props.setTestInput(e.target.value)}
              placeholder="Digite uma mensagem..."
              className="bg-white/[0.02] border-white/[0.08] text-foreground h-10 flex-1 rounded-lg"
            />
            <Button type="submit" disabled={props.testLoading} className="h-10 w-10 p-0 rounded-lg shrink-0">
              <Send className="w-4 h-4" />
            </Button>
          </form>
        </div>

        {/* Timeline sidebar */}
        <div className="w-full md:w-72 border border-white/[0.08] bg-card/80 rounded-xl shadow-none flex flex-col p-5 overflow-hidden">
          <div className="flex items-center justify-between pb-3">
            <h4 className="text-sm font-medium text-foreground">Progresso</h4>
            <span className="text-xs font-mono text-blue-300 bg-blue-500/15 px-2 py-0.5 rounded-md">
              {Math.min(props.testStageIndex, props.stages.length || 0)}/{props.stages.length || 0}
            </span>
          </div>

          <div className="w-full bg-white/[0.06] h-1 rounded-full mb-5 overflow-hidden">
            <div
              className="bg-blue-500 h-full rounded-full transition-all duration-500"
              style={{ width: `${props.stages.length > 0 ? (Math.min(props.testStageIndex, props.stages.length) / props.stages.length) * 100 : 0}%` }}
            />
          </div>

          <div className="flex-1 overflow-y-auto space-y-3">
            {props.stages.length === 0 && (
              <p className="text-xs text-muted-foreground italic text-center mt-4">Nenhuma etapa cadastrada.</p>
            )}
            {props.stages.map((stage, idx) => {
              const isCompleted = props.testStageIndex > idx;
              const isActive = props.testStageIndex === idx;
              const isSkipped = props.testSkippedStages.includes(idx);

              return (
                <div key={stage.id} className="relative flex gap-3">
                  {idx !== props.stages.length - 1 && (
                    <div className={cn("absolute left-3 top-8 bottom-[-12px] w-0.5", isCompleted ? "bg-emerald-500" : "bg-white/[0.08]")} />
                  )}

                  <div className={cn(
                    "w-7 h-7 rounded-full flex items-center justify-center shrink-0 z-10 border-2 transition-colors",
                    isCompleted
                      ? "bg-emerald-500 border-emerald-500 text-white"
                      : isActive
                        ? "bg-blue-500 border-blue-500 text-white"
                        : "bg-card border-white/[0.12] text-muted-foreground"
                  )}>
                    {isCompleted ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : isActive ? (
                      <div className="w-1.5 h-1.5 bg-white rounded-full" />
                    ) : (
                      <span className="text-[10px] font-medium">{idx + 1}</span>
                    )}
                  </div>

                  <div className={cn(
                    "min-w-0 pb-2 flex-1 rounded-lg p-3 transition-colors",
                    isActive ? "bg-blue-500/10 border border-blue-500/20" : "bg-transparent"
                  )}>
                    <h5 className={cn(
                      "text-xs font-medium",
                      isCompleted ? "text-emerald-300" : isActive ? "text-blue-300" : "text-muted-foreground"
                    )}>
                      {stage.title}
                    </h5>

                    {isCompleted && <p className="text-[10px] text-emerald-400/70 mt-0.5">Concluída</p>}

                    {isActive && (
                      <>
                        <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2 italic">{stage.goal_prompt}</p>
                        <p className="text-[10px] text-blue-300 font-medium mt-2 flex items-center gap-1.5">
                          <span className="w-1 h-1 bg-blue-400 rounded-full inline-block" /> Em andamento
                        </p>
                      </>
                    )}

                    {isSkipped && <p className="text-[10px] text-muted-foreground mt-0.5">Pulada (condição não atendida)</p>}

                    {(isCompleted || isActive) && !isSkipped && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {(Array.isArray(stage.captured_variables) ? stage.captured_variables : []).map((v: any, vi: number) => {
                          const val = props.testVariables[v.name];
                          if (!val) return null;
                          return (
                            <span key={vi} className="text-[10px] bg-blue-500/15 text-blue-200 px-2 py-0.5 rounded-md border border-blue-500/20 inline-flex items-center gap-1">
                              <span className="opacity-70">{v.name}:</span>
                              <span className="font-medium truncate">{val}</span>
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}