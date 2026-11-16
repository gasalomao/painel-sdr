"use client";

import { Button } from "@/components/ui/button";
import { Bot, Plus, Trash2 } from "lucide-react";

type AgentRow = { id: number; name: string };

export function AgentSwitcher({
  activeAgentId,
  agentsList,
  setAgentsList,
  setActiveAgentId,
  loadAgent,
}: {
  activeAgentId: number;
  agentsList: AgentRow[];
  setAgentsList: (v: AgentRow[]) => void;
  setActiveAgentId: (id: number) => void;
  loadAgent: (id: number) => void;
  clientId?: string | null;
}) {
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
      <div className="flex items-center gap-2">
        <Button
          onClick={handleCreate}
          variant="secondary"
          className="h-11 rounded-lg text-sm font-medium gap-2 px-4 bg-white/5 text-foreground border border-white/10 hover:bg-white/10"
        >
          <Plus className="w-3 h-3" /> Criar Novo
        </Button>
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
    </div>
  );
}
