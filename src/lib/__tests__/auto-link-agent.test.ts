import { describe, it, expect } from "vitest";
import { pickAgentForInstance } from "../auto-link-agent-core";

/**
 * Cobre as 3 regras do auto-vínculo de Agente de IA ao escanear o QR:
 *   1. Normalmente → primeiro agente.
 *   2. Primeiro já conectado em outra instância → outro agente não-vinculado.
 *   3. Nenhum agente livre → cria um novo.
 * + Regra 0: se a instância já tem um agente válido, não mexe.
 */
describe("pickAgentForInstance — auto-vínculo de agente no QR", () => {
  const agents = [{ id: 1, name: "Agente A" }, { id: 2, name: "Agente B" }, { id: 3, name: "Agente C" }];

  it("Regra 1 — instância nova vincula ao primeiro agente", () => {
    const choice = pickAgentForInstance({
      currentAgentId: null,
      agents,
      usedAgentIds: new Set(),
      connectedAgentIds: new Set(),
    });
    expect(choice).toEqual({ kind: "link", agentId: 1 });
  });

  it("Regra 2 — primeiro agente já conectado em outra instância → pega o próximo livre", () => {
    const choice = pickAgentForInstance({
      currentAgentId: null,
      agents,
      usedAgentIds: new Set([1]), // agente 1 já vinculado à outra instância
      connectedAgentIds: new Set([1]), // e essa outra instância está conectada
    });
    expect(choice).toEqual({ kind: "link", agentId: 2 });
  });

  it("Regra 2 — pula agentes ocupados e escolhe o primeiro realmente livre", () => {
    const choice = pickAgentForInstance({
      currentAgentId: null,
      agents,
      usedAgentIds: new Set([1, 2]), // 1 e 2 ocupados
      connectedAgentIds: new Set([1]),
    });
    expect(choice).toEqual({ kind: "link", agentId: 3 });
  });

  it("Regra 3 — todos os agentes ocupados → cria um novo", () => {
    const choice = pickAgentForInstance({
      currentAgentId: null,
      agents,
      usedAgentIds: new Set([1, 2, 3]),
      connectedAgentIds: new Set([1]),
    });
    expect(choice).toEqual({ kind: "create" });
  });

  it("Regra 3 — cliente sem nenhum agente → cria um novo", () => {
    const choice = pickAgentForInstance({
      currentAgentId: null,
      agents: [],
      usedAgentIds: new Set(),
      connectedAgentIds: new Set(),
    });
    expect(choice).toEqual({ kind: "create" });
  });

  it("Regra 0 — instância já tem agente válido e livre → mantém", () => {
    const choice = pickAgentForInstance({
      currentAgentId: 2,
      agents,
      usedAgentIds: new Set([2]),
      connectedAgentIds: new Set(),
    });
    expect(choice).toEqual({ kind: "keep", agentId: 2 });
  });

  it("Regra 0 NÃO aplica — agente atual está conectado em outra instância → reatribui", () => {
    // Caso real: 2 instâncias criadas, ambas default no agente 1. A 1ª conecta
    // e fica com o agente 1. A 2ª, ao conectar, NÃO pode ficar no mesmo.
    const choice = pickAgentForInstance({
      currentAgentId: 1,
      agents,
      usedAgentIds: new Set([1]),
      connectedAgentIds: new Set([1]), // agente 1 ocupado na outra instância conectada
    });
    expect(choice).toEqual({ kind: "link", agentId: 2 });
  });

  it("Regra 0 NÃO aplica — agente atual aponta pra agente inexistente → reatribui", () => {
    const choice = pickAgentForInstance({
      currentAgentId: 99, // agente apagado / de outro cliente
      agents,
      usedAgentIds: new Set(),
      connectedAgentIds: new Set(),
    });
    expect(choice).toEqual({ kind: "link", agentId: 1 });
  });

  it("primeiro agente vinculado a outra instância mas DESCONECTADA → ainda pode usar o primeiro", () => {
    // Vínculo não basta pra bloquear — só conta se a outra instância está ABERTA.
    const choice = pickAgentForInstance({
      currentAgentId: null,
      agents,
      usedAgentIds: new Set([1]), // 1 vinculado a outra instância...
      connectedAgentIds: new Set(), // ...mas ela está offline → 1 está livre
    });
    expect(choice).toEqual({ kind: "link", agentId: 1 });
  });
});
