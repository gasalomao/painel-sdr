"use client";

import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { Plus, Trash2 } from "lucide-react";

type AgentRow = { id: number; name: string };

export function AgentSwitcher({
  activeAgentId,
  agentsList,
  setAgentsList,
  setActiveAgentId,
  loadAgent,
  clientId,
}: {
  activeAgentId: number;
  agentsList: AgentRow[];
  setAgentsList: (v: AgentRow[]) => void;
  setActiveAgentId: (id: number) => void;
  loadAgent: (id: number) => void;
  clientId: string | null;
}) {
  const handleCreate = async () => {
    const randomId = Math.floor(Math.random() * 90000) + 1000;
    const insertPayload: any = { id: randomId, name: "Novo Agente" };
    if (clientId) insertPayload.client_id = clientId;
    
    const { data } = await supabase.from("agent_settings").insert(insertPayload).select();
    if (data && data[0]) {
      setAgentsList([...agentsList, data[0]]);
      setActiveAgentId(data[0].id);
      loadAgent(data[0].id);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Deletar agente?")) return;
    const q = supabase.from("agent_settings").delete().eq("id", activeAgentId);
    if (clientId) q.eq("client_id", clientId);
    await q;

    const filtered = agentsList.filter((a) => a.id !== activeAgentId);
    setAgentsList(filtered);
    if (filtered.length > 0) {
      setActiveAgentId(filtered[0].id);
      loadAgent(filtered[0].id);
    }
  };

  return (
    <div className="bg-gradient-to-r from-purple-800 via-primary/80 to-blue-900 border-b border-white/10 px-3 sm:px-8 py-2 sm:py-3 flex items-center justify-between gap-2 shadow-lg shadow-primary/5">
      <div className="flex bg-black/40 border border-white/20 p-1 rounded-xl">
        <select
          value={activeAgentId}
          onChange={(e) => {
            const id = Number(e.target.value);
            setActiveAgentId(id);
            loadAgent(id);
          }}
          className="bg-transparent text-white font-bold text-xs uppercase tracking-widest pl-3 pr-8 focus:outline-none"
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
          className="h-8 rounded-lg text-xs font-bold gap-2 px-4 shadow-sm hover:scale-105 transition-transform bg-white/10 text-white border border-white/20 hover:bg-white/20"
        >
          <Plus className="w-3 h-3" /> Criar Novo
        </Button>
        <Button
          onClick={handleDelete}
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-red-500 hover:text-red-400 hover:bg-red-500/20 rounded-lg"
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
