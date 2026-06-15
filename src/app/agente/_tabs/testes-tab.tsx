"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { greetingFor, renderTemplate, TEMPLATE_VARIABLES } from "@/lib/template-vars";
import { Bot, Check, FlaskConical, Globe, Loader2, Send, Sparkles, Trash2 } from "lucide-react";
import { LeadSelectorUI, type PreviewLead, type PreviewSample } from "../_components/lead-selector";
import { Toggle } from "../_components/toggle";

type TestMessage = { role: "user" | "agent" | "tool"; content: string; isError?: boolean };

// Detecta o tipo de tool a partir do conteúdo do log → pra colorir o card.
function toolMeta(content: string): { label: string; color: "purple" | "blue" | "amber" | "gray"; icon: string } {
  if (/RAG|search_knowledge_base/i.test(content)) return { label: "Base de conhecimento", color: "purple", icon: "📚" };
  if (/Google Calendar|calendar/i.test(content)) return { label: "Google Calendar (MCP)", color: "blue", icon: "📅" };
  if (/Webhook Custom/i.test(content)) return { label: "Tool customizada", color: "amber", icon: "🔌" };
  return { label: "Tool", color: "gray", icon: "⚙️" };
}

const TOOL_COLOR: Record<string, string> = {
  purple: "bg-purple-500/10 border-purple-500/30 text-purple-200",
  blue: "bg-blue-500/10 border-blue-500/30 text-blue-200",
  amber: "bg-amber-500/10 border-amber-500/30 text-amber-200",
  gray: "bg-white/5 border-white/10 text-white/80",
};

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
    <div className="flex flex-col gap-6">
      {/* ============= SIMULAÇÃO DE LEAD / DISPARO ============= */}
      <div className="bg-[#0b141a] border border-white/10 rounded-[2.5rem] p-6 shadow-2xl relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/[0.02] to-transparent pointer-events-none" />
        <div className="relative z-10 space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h4 className="font-bold text-white flex items-center gap-2">
                <FlaskConical className="w-5 h-5 text-cyan-400" /> Simulação de Lead / Disparo
              </h4>
              <p className="text-[10px] text-muted-foreground mt-1">
                Escolha um lead para preencher as variáveis e simular a primeira mensagem (Disparo Inicial).
              </p>
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
              <Button onClick={props.loadPreviewLeads} className="bg-cyan-500 hover:bg-cyan-600 text-white font-bold text-[10px] h-7 px-4 rounded-full">
                Carregar Leads
              </Button>
            </div>
          ) : (
            <div className="bg-black/30 p-4 rounded-xl border border-white/5 space-y-4 mt-4">
              {/* Template */}
              <div>
                <label className="text-[10px] font-bold uppercase text-cyan-400 tracking-widest block mb-2">
                  Template da Mensagem Inicial
                </label>

                <div className="flex flex-wrap gap-1.5 mb-2">
                  {TEMPLATE_VARIABLES.map((v) => (
                    <button
                      key={v.key}
                      type="button"
                      onClick={() => props.setSandboxTemplate(props.sandboxTemplate + `{{${v.key}}}`)}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData("text/plain", `{{${v.key}}}`)}
                      className="text-[10px] font-mono px-2 py-1 rounded-md bg-purple-500/10 border border-purple-500/30 text-purple-200 hover:bg-purple-500/20 transition-colors"
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
                  className="w-full bg-[#202c33] border border-white/10 text-white font-mono text-xs p-3 rounded-xl min-h-[60px] focus:outline-none focus:border-cyan-500/50"
                />

                <div className="mt-2 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/15">
                  <p className="text-[9px] uppercase font-black tracking-widest text-emerald-400 mb-1">
                    Pré-visualização do Template Base
                  </p>
                  <p className="text-[11px] text-emerald-100/90 whitespace-pre-wrap font-mono">{previewSandboxMessage}</p>
                  <p className="text-[9px] text-emerald-100/50 mt-2 italic">
                    Saudação atual: <strong>{greetingFor()}</strong>
                  </p>
                </div>
              </div>

              {/* Toggle: Personalizar com IA */}
              <div className="flex items-center justify-between bg-[#202c33] p-3 rounded-xl border border-white/5">
                <div>
                  <div className="text-xs font-bold text-white flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-purple-400" /> Personalizar com IA
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-1">
                    Reescreve a mensagem usando o modelo definido (<span className="text-purple-300 font-mono">{props.targetModel}</span>)
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

              {/* Configurações da personalização IA (collapsible) */}
              {props.sandboxPersonalizeAI && (
                <div className="space-y-4 animate-in fade-in slide-in-from-top-2 p-3 bg-purple-500/5 rounded-xl border border-purple-500/20">
                  <div>
                    <label className="text-[10px] font-bold uppercase text-purple-400 tracking-widest block mb-2">
                      Prompt da IA
                    </label>
                    <textarea
                      value={props.sandboxAiPrompt}
                      onChange={(e) => props.setSandboxAiPrompt(e.target.value)}
                      className="w-full bg-[#202c33] border border-purple-500/20 text-white text-xs p-3 rounded-xl min-h-[100px] focus:outline-none focus:border-purple-500/50"
                    />
                  </div>
                  <div className="flex items-center justify-between bg-[#202c33] p-3 rounded-xl border border-purple-500/20">
                    <div>
                      <div className="text-[10px] font-bold text-white flex items-center gap-1">
                        <Globe className="w-3 h-3 text-purple-400" /> Usar Web Search
                      </div>
                      <div className="text-[9px] text-muted-foreground mt-0.5">
                        Permite à IA pesquisar na web informações da empresa do lead.
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

              <div className="flex justify-end pt-2">
                <Button
                  onClick={props.simulateInitialMessage}
                  disabled={props.sandboxSimulating || !props.previewSample.telefone}
                  className="bg-cyan-500 hover:bg-cyan-600 text-white font-bold h-10 px-6 rounded-xl shadow-lg shadow-cyan-500/20"
                >
                  {props.sandboxSimulating ? (
                    <span className="flex items-center"><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Gerando Mensagem...</span>
                  ) : (
                    <span className="flex items-center"><Send className="w-4 h-4 mr-2" /> Disparar Primeira Mensagem</span>
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ============= CHAT + TIMELINE ============= */}
      <div className="flex flex-col md:flex-row gap-6 h-[550px]">
        {/* Chat */}
        <div className="flex-1 bg-[#0b141a] border border-white/10 rounded-[2.5rem] overflow-hidden flex flex-col relative shadow-2xl">
          <div className="bg-[#202c33] p-4 flex items-center justify-between border-b border-white/5">
            <div className="flex items-center gap-3">
              <Bot className="w-5 h-5 text-primary" />
              <div>
                <h4 className="text-white font-medium text-sm">{props.nomeAgente} (Sandbox)</h4>
                <p className="text-[9px] text-white/40">
                  Modelo: <span className="text-white/70 font-mono">{props.targetModel || "—"}</span>
                  {" · "}
                  {props.humanizeMessages
                    ? <span className="text-[#00ffcc]">Picote ON (msgs quebradas)</span>
                    : <span className="text-white/40">Picote OFF</span>}
                  {props.messageBufferSeconds > 0 && (
                    <span className="text-white/40"> · Buffer {props.messageBufferSeconds}s</span>
                  )}
                </p>
              </div>
            </div>
            <Button
              onClick={props.clearTestSession}
              variant="ghost"
              size="icon"
              className="text-white/40"
              title="Limpar conversa de teste"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
            {props.testMessages.map((msg, i) => {
              if (msg.role === "tool") {
                const meta = toolMeta(msg.content);
                return (
                  <div key={i} className="flex justify-center">
                    <div className={cn("max-w-[90%] rounded-xl p-2.5 border text-[11px] font-mono leading-relaxed", TOOL_COLOR[meta.color])}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-base">{meta.icon}</span>
                        <span className="text-[9px] font-black uppercase tracking-widest opacity-80">Tool · {meta.label}</span>
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
                      msg.role === "user" ? "bg-[#005c4b] text-white"
                        : msg.isError ? "bg-red-500/15 border border-red-500/40 text-red-200"
                        : "bg-[#202c33] text-[#e9edef]"
                    )}
                  >
                    {msg.content}
                  </div>
                </div>
              );
            })}
            {props.testLoading && <div className="text-[10px] text-muted-foreground animate-pulse pl-4">Digitando...</div>}
          </div>

          <form onSubmit={props.handleTestSubmit} className="bg-[#2a3942] p-3 flex gap-2">
            <Input
              value={props.testInput}
              onChange={(e) => props.setTestInput(e.target.value)}
              placeholder="Envie uma mensagem..."
              className="bg-transparent border-none text-white h-10 flex-1 px-4"
            />
            <Button type="submit" disabled={props.testLoading} className="bg-[#00a884] h-10 w-10 p-0 rounded-full shrink-0">
              <Send className="w-4 h-4" />
            </Button>
          </form>
        </div>

        {/* Timeline sidebar */}
        <div className="w-full md:w-80 bg-white/5 border border-white/10 rounded-[2.5rem] overflow-hidden flex flex-col p-6 shadow-xl">
          <div className="flex items-center justify-between pb-2">
            <h4 className="font-bold text-sm text-white">Progresso</h4>
            <span className="text-[10px] font-bold text-blue-400 bg-blue-500/20 px-2 py-0.5 rounded-full font-mono">
              {Math.min(props.testStageIndex, props.stages.length || 0)}/{props.stages.length || 0}
            </span>
          </div>

          <div className="w-full bg-white/10 h-1 rounded-full mb-6 overflow-hidden">
            <div
              className="bg-blue-500 h-full rounded-full transition-all duration-500"
              style={{ width: `${props.stages.length > 0 ? (Math.min(props.testStageIndex, props.stages.length) / props.stages.length) * 100 : 0}%` }}
            />
          </div>

          <div className="flex-1 overflow-y-auto space-y-6 custom-scrollbar pr-2">
            {props.stages.length === 0 && (
              <p className="text-xs text-muted-foreground italic text-center mt-4">Nenhuma etapa cadastrada.</p>
            )}
            {props.stages.map((stage, idx) => {
              const isCompleted = props.testStageIndex > idx;
              const isActive = props.testStageIndex === idx;
              const isSkipped = props.testSkippedStages.includes(idx);

              return (
                <div key={stage.id} className="relative flex gap-4">
                  {idx !== props.stages.length - 1 && (
                    <div className={cn("absolute left-3.5 top-8 bottom-[-24px] w-0.5", isCompleted ? "bg-green-500" : "bg-white/10")} />
                  )}

                  <div className={cn(
                    "w-7 h-7 rounded-full flex items-center justify-center shrink-0 z-10 border-2 transition-all duration-300",
                    isCompleted
                      ? "bg-green-500 border-green-500 text-white shadow-[0_0_10px_rgba(34,197,94,0.3)]"
                      : isActive
                        ? "bg-blue-500 border-blue-500 text-white shadow-[0_0_10px_rgba(59,130,246,0.3)]"
                        : "bg-black border-white/20 text-muted-foreground"
                  )}>
                    {isCompleted ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : isActive ? (
                      <div className="w-1.5 h-1.5 bg-white rounded-full" />
                    ) : (
                      <span className="text-[10px] font-bold">{idx + 1}</span>
                    )}
                  </div>

                  <div className={cn(
                    "min-w-0 pb-2 flex-1 rounded-2xl p-3.5 transition-all duration-300",
                    isActive ? "bg-blue-500/10 border border-blue-500/30" : "bg-transparent"
                  )}>
                    <h5 className={cn(
                      "text-xs font-bold",
                      isCompleted ? "text-green-500" : isActive ? "text-blue-400" : "text-white/40"
                    )}>
                      {stage.title}
                    </h5>

                    {isCompleted && <p className="text-[10px] text-green-500/70 mt-0.5">Concluída</p>}

                    {isActive && (
                      <>
                        <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2 italic">{stage.goal_prompt}</p>
                        <p className="text-[10px] text-blue-400 font-bold mt-2 flex items-center gap-1 animate-pulse">
                          <span className="w-1 h-1 bg-blue-400 rounded-full inline-block" /> Em andamento...
                        </p>
                      </>
                    )}

                    {isSkipped && <p className="text-[9px] text-muted-foreground mt-0.5">Pulada (condição não atendida)</p>}

                    {/* Variáveis coletadas */}
                    {(isCompleted || isActive) && !isSkipped && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {(Array.isArray(stage.captured_variables) ? stage.captured_variables : []).map((v: any, vi: number) => {
                          const val = props.testVariables[v.name];
                          if (!val) return null;
                          return (
                            <div key={vi} className="text-[9px] bg-blue-500/20 text-blue-300 px-2 py-0.5 rounded-full border border-blue-500/30 flex items-center gap-1">
                              <span className="opacity-70">{v.name}:</span>
                              <span className="font-bold truncate">{val}</span>
                            </div>
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
