/**
 * auto-link-agent — vincula automaticamente um Agente de IA a uma instância
 * de WhatsApp no momento em que ela CONECTA (QR escaneado → status "open").
 *
 * Regras (pedido do cliente):
 *   1. Normalmente vincula ao PRIMEIRO agente do cliente.
 *   2. Se esse primeiro agente já estiver servindo OUTRA instância conectada,
 *      escolhe outro agente que não esteja vinculado a NENHUMA instância
 *      (pra dois números nunca compartilharem o mesmo agente — evita confusão
 *      de contexto e respostas cruzadas).
 *   3. Se NÃO existir nenhum agente livre, CRIA um novo agente e vincula a ele.
 *
 * Idempotente: se a instância já tem um agente válido (não usado por outra
 * conexão aberta), não mexe. Pode ser chamada quantas vezes for — em cada
 * evento `connection.update` e em cada polling de status.
 */

import { supabaseAdmin } from "@/lib/supabase_admin";
import { pickAgentForInstance, type AgentChoice } from "@/lib/auto-link-agent-core";

// Re-export pra quem já importava daqui continuar funcionando.
export { pickAgentForInstance, type AgentChoice };

const DEFAULT_PROMPT =
  "Você é o assistente virtual oficial da empresa. Seu objetivo é atender, " +
  "qualificar leads e agendar reuniões de forma cordial e objetiva.";

export interface AutoLinkResult {
  ok: boolean;
  /** "kept" = já estava ok | "linked" = vinculou a agente existente | "created" = criou agente novo */
  action: "kept" | "linked" | "created" | "skipped";
  agentId?: number | null;
  agentName?: string | null;
  reason?: string;
}

/**
 * Garante que `instanceName` tenha um agente de IA vinculado, seguindo as
 * regras do topo do arquivo. Server-side (usa supabaseAdmin — ignora RLS).
 */
export async function autoLinkAgentOnConnect(instanceName: string): Promise<AutoLinkResult> {
  if (!instanceName) return { ok: false, action: "skipped", reason: "instanceName vazio" };
  if (!supabaseAdmin) return { ok: false, action: "skipped", reason: "DB indisponível" };

  try {
    // 1) Conexão que acabou de abrir.
    const { data: conn } = await supabaseAdmin
      .from("channel_connections")
      .select("instance_name, agent_id, client_id, status")
      .eq("instance_name", instanceName)
      .maybeSingle();
    if (!conn) return { ok: false, action: "skipped", reason: "conexão não encontrada" };
    if (!conn.client_id) return { ok: false, action: "skipped", reason: "conexão sem client_id" };
    const clientId = conn.client_id;

    // 2) Outras conexões do MESMO cliente — pra saber quais agentes já estão
    //    "ocupados" (vinculados a alguma instância) e quais estão "conectados"
    //    (vinculados a uma instância que está aberta agora).
    const { data: allConns } = await supabaseAdmin
      .from("channel_connections")
      .select("instance_name, agent_id, status")
      .eq("client_id", clientId);
    const others = (allConns || []).filter((c) => c.instance_name !== instanceName);
    const usedAgentIds = new Set(
      others.map((c) => c.agent_id).filter((x): x is number => !!x),
    );
    const connectedAgentIds = new Set(
      others
        .filter((c) => String(c.status || "").toLowerCase() === "open")
        .map((c) => c.agent_id)
        .filter((x): x is number => !!x),
    );

    // 3) Agentes do cliente, ordenados (o "primeiro" = menor id).
    const { data: agents } = await supabaseAdmin
      .from("agent_settings")
      .select("id, name")
      .eq("client_id", clientId)
      .order("id", { ascending: true });

    // 4) Decisão pura.
    const choice = pickAgentForInstance({
      currentAgentId: conn.agent_id ?? null,
      agents: agents || [],
      usedAgentIds,
      connectedAgentIds,
    });

    if (choice.kind === "keep") {
      const name = (agents || []).find((a) => a.id === choice.agentId)?.name || null;
      return { ok: true, action: "kept", agentId: choice.agentId, agentName: name };
    }

    let targetId: number;
    let targetName: string | null;
    let action: AutoLinkResult["action"];

    if (choice.kind === "link") {
      targetId = choice.agentId;
      targetName = (agents || []).find((a) => a.id === choice.agentId)?.name || null;
      action = "linked";
    } else {
      // Regra 3 — cria um agente novo.
      const nextNum = (agents?.length || 0) + 1;
      const newName = nextNum > 1 ? `Agente ${nextNum}` : "Agente Principal";
      const { data: newAg, error: agErr } = await supabaseAdmin
        .from("agent_settings")
        .insert({
          client_id: clientId,
          name: newName,
          main_prompt: DEFAULT_PROMPT,
          is_active: true,
        })
        .select("id, name")
        .single();
      if (agErr || !newAg) {
        return { ok: false, action: "skipped", reason: `falha criando agente: ${agErr?.message}` };
      }
      targetId = newAg.id;
      targetName = newAg.name;
      action = "created";
    }

    // 5) Vincula (só grava se mudou de fato).
    if (targetId !== conn.agent_id) {
      const { error: updErr } = await supabaseAdmin
        .from("channel_connections")
        .update({ agent_id: targetId })
        .eq("instance_name", instanceName)
        .eq("client_id", clientId);
      if (updErr) {
        return { ok: false, action: "skipped", reason: `falha vinculando: ${updErr.message}` };
      }
    }
    console.log(
      `[AUTO-LINK] Instância "${instanceName}" → agente #${targetId} "${targetName}" (${action}).`,
    );
    return { ok: true, action, agentId: targetId, agentName: targetName };
  } catch (e) {
    console.warn("[AUTO-LINK] erro:", (e as Error).message);
    return { ok: false, action: "skipped", reason: (e as Error).message };
  }
}
