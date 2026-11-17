import { isAutoPoolInstance } from "@/lib/campaign-pool";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { isInstanceOwnedByClient } from "@/lib/tenant";

export type InstanceAccessResult =
  | { ok: true }
  | { ok: false; status: 400 | 403; error: string };

export type AgentAccessResult =
  | { ok: true; agentId: number | null }
  | { ok: false; status: 400 | 403; error: string };

/**
 * Valida se o agent_id informado pertence ao tenant autenticado.
 * Quando omitido/null, retorna ok com agentId=null sem acessar o banco.
 */
export async function validateClientAgentAccess(
  clientId: string,
  rawAgentId: unknown
): Promise<AgentAccessResult> {
  if (rawAgentId === undefined || rawAgentId === null || String(rawAgentId).trim() === "") {
    return { ok: true, agentId: null };
  }

  const parsed = Number(rawAgentId);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, status: 400, error: "agent_id inválido" };
  }

  const { data } = await supabase
    .from("agent_settings")
    .select("id")
    .eq("id", parsed)
    .eq("client_id", clientId)
    .maybeSingle();

  if (!data) {
    return { ok: false, status: 403, error: "Agente não pertence a este cliente" };
  }

  return { ok: true, agentId: parsed };
}

/**
 * Valida se o cliente pode usar a instância informada ou o Pool Automático
 * (`__auto_pool__`), garantindo isolamento multi-tenant no servidor.
 */
export async function validateCampaignInstanceAccess(
  clientId: string,
  instanceName: string
): Promise<InstanceAccessResult> {
  if (isAutoPoolInstance(instanceName)) {
    const { count } = await supabase
      .from("channel_connections")
      .select("instance_name", { count: "exact", head: true })
      .eq("client_id", clientId);

    if (!count || count <= 0) {
      return {
        ok: false,
        status: 400,
        error: "Conecte pelo menos uma conta WhatsApp para usar o Pool Automático",
      };
    }
    return { ok: true };
  }

  const owned = await isInstanceOwnedByClient(instanceName, clientId);
  if (!owned) {
    return {
      ok: false,
      status: 403,
      error: "Instância não pertence a este cliente",
    };
  }

  return { ok: true };
}

