/**
 * auto-link-agent-core — DECISÃO PURA (sem I/O) de qual Agente de IA vincular
 * a uma instância de WhatsApp quando ela conecta (QR escaneado).
 *
 * Isolado neste arquivo, sem nenhum import, pra ser testável sem arrastar o
 * Supabase junto (mesmo padrão do automation-lead-scope.ts). O wrapper com
 * I/O fica em auto-link-agent.ts.
 *
 * Regras (pedido do cliente):
 *   1. Normalmente vincula ao PRIMEIRO agente do cliente.
 *   2. Se esse primeiro agente já estiver servindo OUTRA instância conectada,
 *      escolhe outro agente que não esteja vinculado a NENHUMA instância.
 *   3. Se NÃO existir nenhum agente livre, CRIA um novo agente.
 *   0. Se a instância já tem um agente válido e livre, não mexe.
 */

export type AgentChoice =
  | { kind: "keep"; agentId: number }
  | { kind: "link"; agentId: number }
  | { kind: "create" };

/**
 * @param currentAgentId    agente atualmente vinculado à instância (ou null)
 * @param agents            agentes do cliente, ORDENADOS por id crescente
 * @param usedAgentIds      agentes vinculados a QUALQUER outra instância
 * @param connectedAgentIds agentes vinculados a outra instância CONECTADA agora
 */
export function pickAgentForInstance(input: {
  currentAgentId: number | null;
  agents: { id: number; name?: string | null }[];
  usedAgentIds: Set<number>;
  connectedAgentIds: Set<number>;
}): AgentChoice {
  const { currentAgentId, agents, usedAgentIds, connectedAgentIds } = input;

  // Regra 0 — já tem um agente válido (existe e não está conectado em outra
  // instância): respeita a escolha atual, não sobrescreve.
  if (
    currentAgentId &&
    agents.some((a) => a.id === currentAgentId) &&
    !connectedAgentIds.has(currentAgentId)
  ) {
    return { kind: "keep", agentId: currentAgentId };
  }

  if (agents.length > 0) {
    const first = agents[0];
    // Regra 1 — primeiro agente, se ele não estiver conectado em outra instância.
    if (!connectedAgentIds.has(first.id)) {
      return { kind: "link", agentId: first.id };
    }
    // Regra 2 — primeiro ocupado: pega o primeiro que não esteja vinculado
    // a NENHUMA instância.
    const free = agents.find((a) => !usedAgentIds.has(a.id));
    if (free) return { kind: "link", agentId: free.id };
  }

  // Regra 3 — nenhum agente livre: cria um novo.
  return { kind: "create" };
}
