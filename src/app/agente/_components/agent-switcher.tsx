"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Bot, Copy, Plus, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";

type AgentRow = { id: number; name: string };
type InstanceOption = string | { instance_name: string; agent_id?: number | null; status?: string };

function normalizeInstanceOption(item: InstanceOption): { instance_name: string; agent_id?: number | null } {
  if (typeof item === "string") return { instance_name: item, agent_id: null };
  return { instance_name: item.instance_name, agent_id: item.agent_id ?? null };
}

export function AgentSwitcher({
  activeAgentId,
  agentsList,
  setAgentsList,
  setActiveAgentId,
  loadAgent,
  allInstances = [],
  onApplyMentorPreset,
}: {
  activeAgentId: number;
  agentsList: AgentRow[];
  setAgentsList: (v: AgentRow[]) => void;
  setActiveAgentId: (id: number) => void;
  loadAgent: (id: number) => void;
  clientId?: string | null;
  allInstances?: InstanceOption[];
  onApplyMentorPreset?: () => void;
}) {
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneName, setCloneName] = useState("");
  const [cloneInstance, setCloneInstance] = useState("");
  const [cloneKnowledge, setCloneKnowledge] = useState(true);
  const [cloneStages, setCloneStages] = useState(true);
  const [cloning, setCloning] = useState(false);

  const handleOpenClone = () => {
    const current = agentsList.find((a) => a.id === activeAgentId);
    setCloneName(`${current?.name || "Agente"} (Cópia)`);
    const normalized = allInstances.map(normalizeInstanceOption);
    const freeInst = normalized.find((i) => !i.agent_id)?.instance_name || "";
    setCloneInstance(freeInst);
    setCloneOpen(true);
  };

  const handleClone = async () => {
    if (!cloneName.trim()) {
      toast.error("Informe um nome para o agente duplicado.");
      return;
    }
    setCloning(true);
    try {
      const res = await fetch("/api/agent/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "clone_agent",
          source_agent_id: activeAgentId,
          new_name: cloneName.trim(),
          target_instance_name: cloneInstance || null,
          clone_knowledge: cloneKnowledge,
          clone_stages: cloneStages,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.agent) {
        toast.error(json?.error || "Erro ao duplicar agente");
        return;
      }
      const created: AgentRow = { id: json.agent.id, name: json.agent.name };
      setAgentsList([...agentsList, created]);
      setActiveAgentId(created.id);
      loadAgent(created.id);
      setCloneOpen(false);
      toast.success(
        json.bound_instance
          ? `Agente duplicado e vinculado ao número ${json.bound_instance}!`
          : "Agente duplicado com sucesso!"
      );
    } catch {
      toast.error("Erro ao duplicar agente");
    } finally {
      setCloning(false);
    }
  };
  const handleCreate = async () => {
    const res = await fetch("/api/agent/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create_agent", name: "Novo Agente" }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.agent) {
      alert("Erro ao criar agente: " + (json?.error || "erro desconhecido"));
      return;
    }
    const created: AgentRow = { id: json.agent.id, name: json.agent.name };
    setAgentsList([...agentsList, created]);
    setActiveAgentId(created.id);
    loadAgent(created.id);
  };

  const handleDelete = async () => {
    if (!confirm("Deletar agente?")) return;
    const res = await fetch(`/api/agent/settings?agent_id=${activeAgentId}`, {
      method: "DELETE",
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      alert("Erro ao deletar agente: " + (json?.error || "erro desconhecido"));
      return;
    }

    const filtered = agentsList.filter((a) => a.id !== activeAgentId);
    setAgentsList(filtered);
    if (filtered.length > 0) {
      setActiveAgentId(filtered[0].id);
      loadAgent(filtered[0].id);
    }
  };

  return (
    <div className="border-b border-white/10 bg-card/60">
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-4 flex flex-wrap items-end justify-between gap-3">
      <div className="flex-1 min-w-0 basis-32 max-w-md space-y-1.5">
        <label htmlFor="active-agent" className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Bot className="w-4 h-4 text-primary" aria-hidden="true" /> Agente selecionado
        </label>
        <select
          id="active-agent"
          value={activeAgentId}
          onChange={(e) => {
            const id = Number(e.target.value);
            setActiveAgentId(id);
            loadAgent(id);
          }}
          className="w-full min-w-0 h-11 rounded-lg border border-white/15 bg-background text-foreground text-sm font-medium pl-3 pr-8"
        >
          {agentsList.map((a) => (
            <option key={a.id} value={a.id} className="bg-neutral-900">
              {a.name} (ID: {a.id})
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={handleCreate}
          variant="secondary"
          className="h-11 rounded-lg text-sm font-medium gap-2 px-4 bg-white/5 text-foreground border border-white/10 hover:bg-white/10"
        >
          <Plus className="w-3 h-3" /> Criar Novo
        </Button>
        <Button
          onClick={handleOpenClone}
          variant="secondary"
          className="h-11 rounded-lg text-sm font-medium gap-2 px-4 bg-emerald-500/10 text-emerald-300 border border-emerald-500/25 hover:bg-emerald-500/20"
        >
          <Copy className="w-3.5 h-3.5" /> Duplicar Agente
        </Button>
        {onApplyMentorPreset && (
          <Button
            onClick={onApplyMentorPreset}
            variant="secondary"
            title="Carrega o prompt oficial da Sarah (Fase 1 · Método Mentor) neste agente"
            className="h-11 rounded-lg text-sm font-medium gap-2 px-3.5 bg-amber-500/10 text-amber-300 border border-amber-500/25 hover:bg-amber-500/20"
          >
            <Sparkles className="w-3.5 h-3.5" /> Preset Sarah Mentor
          </Button>
        )}
        <Button
          onClick={handleDelete}
          variant="ghost"
          size="icon"
          aria-label="Excluir agente selecionado"
          title="Excluir agente selecionado"
          className="h-11 w-11 text-muted-foreground hover:text-red-300 hover:bg-red-500/10 rounded-lg"
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
      </div>

      <Dialog open={cloneOpen} onOpenChange={setCloneOpen}>
        <DialogContent className="bg-neutral-950 border border-white/10 text-neutral-100 sm:max-w-md">
          <DialogTitle className="text-base font-semibold">
            Duplicar Agente para Outro Número
          </DialogTitle>
          <DialogDescription className="text-xs text-neutral-400">
            Copia prompt, modelo, base de conhecimento e etapas de funil sem afetar o agente original.
          </DialogDescription>

          <div className="space-y-3 pt-2">
            <div className="space-y-1">
              <label className="text-xs text-neutral-300">Nome do novo agente</label>
              <input
                type="text"
                value={cloneName}
                onChange={(e) => setCloneName(e.target.value)}
                className="w-full h-10 rounded-lg border border-white/15 bg-neutral-900 px-3 text-sm text-white"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs text-neutral-300">Vincular ao WhatsApp (opcional)</label>
              <select
                value={cloneInstance}
                onChange={(e) => setCloneInstance(e.target.value)}
                className="w-full h-10 rounded-lg border border-white/15 bg-neutral-900 px-3 text-sm text-white"
              >
                <option value="">Sem número por enquanto</option>
                {allInstances.map(normalizeInstanceOption).map((inst) => (
                  <option key={inst.instance_name} value={inst.instance_name}>
                    {inst.instance_name} {inst.agent_id ? `(em uso)` : `(livre)`}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-2 text-xs text-neutral-300 pt-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cloneKnowledge}
                  onChange={(e) => setCloneKnowledge(e.target.checked)}
                />
                Copiar Base de Conhecimento
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cloneStages}
                  onChange={(e) => setCloneStages(e.target.checked)}
                />
                Copiar Etapas do Funil
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-3">
              <Button variant="ghost" onClick={() => setCloneOpen(false)}>
                Cancelar
              </Button>
              <Button onClick={() => void handleClone()} disabled={cloning}>
                {cloning ? "Duplicando..." : "Confirmar Duplicação"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
