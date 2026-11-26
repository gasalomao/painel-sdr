import { supabaseAdmin } from "@/lib/supabase_admin";
import { invalidateAgentConfigCache } from "@/lib/agent-config-cache";

export interface HotswapInstanceParams {
  clientId: string;
  oldInstanceName: string;
  newInstanceName: string;
}

export interface HotswapInstanceResult {
  ok: boolean;
  status: number;
  error?: string;
  migratedAgentIds: number[];
  migratedCampaigns: number;
  migratedFollowups: number;
  migratedAutomations: number;
}

/**
 * Realiza a troca a quente (Hotswap) de um chip banido/desconectado por um chip estepe/reserva,
 * migrando vínculo de agente IA, campanhas, follow-ups e automações sem perder leads nem histórico.
 */
export async function hotswapBannedInstance(
  params: HotswapInstanceParams
): Promise<HotswapInstanceResult> {
  const clientId = String(params.clientId || "").trim();
  const oldInst = String(params.oldInstanceName || "").trim();
  const newInst = String(params.newInstanceName || "").trim();

  if (!clientId || !oldInst || !newInst) {
    return {
      ok: false,
      status: 400,
      error: "old_instance_name e new_instance_name são obrigatórios.",
      migratedAgentIds: [],
      migratedCampaigns: 0,
      migratedFollowups: 0,
      migratedAutomations: 0,
    };
  }
  if (oldInst === newInst) {
    return {
      ok: false,
      status: 400,
      error: "Escolha um número diferente para substituir o chip atual.",
      migratedAgentIds: [],
      migratedCampaigns: 0,
      migratedFollowups: 0,
      migratedAutomations: 0,
    };
  }
  if (!supabaseAdmin) {
    return {
      ok: false,
      status: 500,
      error: "Banco de dados indisponível.",
      migratedAgentIds: [],
      migratedCampaigns: 0,
      migratedFollowups: 0,
      migratedAutomations: 0,
    };
  }

  // Valida que o chip destino pertence ao tenant
  const { data: newConn } = await supabaseAdmin
    .from("channel_connections")
    .select("instance_name, client_id, status")
    .eq("instance_name", newInst)
    .maybeSingle();

  if (newConn && newConn.client_id && newConn.client_id !== clientId) {
    return {
      ok: false,
      status: 403,
      error: "O chip substituto pertence a outro cliente.",
      migratedAgentIds: [],
      migratedCampaigns: 0,
      migratedFollowups: 0,
      migratedAutomations: 0,
    };
  }

  // Protege contra hotswap para um chip que está em quarentena ou reabilitação pós-ban
  try {
    const { data: newWarmup } = await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .select("is_quarantined, career_mode")
      .eq("client_id", clientId)
      .eq("instance_name", newInst)
      .maybeSingle();

    const nw = newWarmup as { is_quarantined?: boolean; career_mode?: string | null } | null;
    if (nw?.is_quarantined || nw?.career_mode === "rehab") {
      return {
        ok: false,
        status: 409,
        error: "O chip substituto selecionado está em quarentena ou reabilitação pós-ban.",
        migratedAgentIds: [],
        migratedCampaigns: 0,
        migratedFollowups: 0,
        migratedAutomations: 0,
      };
    }
  } catch { /* opcional */ }

  const migratedAgentIds: number[] = [];

  // 1. Transfere vínculo de agente IA
  const { data: oldConns } = await supabaseAdmin
    .from("channel_connections")
    .select("agent_id")
    .eq("client_id", clientId)
    .eq("instance_name", oldInst);

  const boundAgentId = (oldConns || [])
    .map((r) => Number((r as { agent_id?: number | null }).agent_id))
    .find((id) => Number.isFinite(id) && id > 0);

  if (boundAgentId) {
    await supabaseAdmin
      .from("channel_connections")
      .upsert(
        {
          instance_name: newInst,
          agent_id: boundAgentId,
          client_id: clientId,
          status: (newConn as { status?: string } | null)?.status || "open",
        },
        { onConflict: "instance_name" }
      );

    await supabaseAdmin
      .from("channel_connections")
      .update({ agent_id: null })
      .eq("client_id", clientId)
      .eq("instance_name", oldInst);

    migratedAgentIds.push(boundAgentId);
    invalidateAgentConfigCache(boundAgentId);
  }

  // 2. Migra campanhas em andamento / pausadas / rascunho
  let migratedCampaigns = 0;
  try {
    const { data: movedCamps } = await supabaseAdmin
      .from("campaigns")
      .update({
        instance_name: newInst,
        updated_at: new Date().toISOString(),
      })
      .eq("client_id", clientId)
      .eq("instance_name", oldInst)
      .in("status", ["running", "paused", "draft"])
      .select("id");
    migratedCampaigns = Array.isArray(movedCamps) ? movedCamps.length : 0;
  } catch { /* ignore */ }

  // 3. Migra campanhas de follow-up
  let migratedFollowups = 0;
  try {
    const { data: movedFollowups } = await supabaseAdmin
      .from("followup_campaigns")
      .update({ instance_name: newInst })
      .eq("client_id", clientId)
      .eq("instance_name", oldInst)
      .select("id");
    migratedFollowups = Array.isArray(movedFollowups) ? movedFollowups.length : 0;
  } catch { /* ignore */ }

  // 4. Migra automações de captação/disparo
  let migratedAutomations = 0;
  try {
    const { data: movedAutos } = await supabaseAdmin
      .from("automations")
      .update({ instance_name: newInst })
      .eq("client_id", clientId)
      .eq("instance_name", oldInst)
      .select("id");
    migratedAutomations = Array.isArray(movedAutos) ? movedAutos.length : 0;
  } catch { /* ignore */ }

  // 5. Migra entregas de prévias agendadas pendentes (evita falha no chip banido)
  try {
    await supabaseAdmin
      .from("scheduled_preview_deliveries")
      .update({ instance_name: newInst, updated_at: new Date().toISOString() })
      .eq("client_id", clientId)
      .eq("instance_name", oldInst)
      .eq("status", "pending");
  } catch { /* tabela opcional sem 031 */ }

  return {
    ok: true,
    status: 200,
    migratedAgentIds,
    migratedCampaigns,
    migratedFollowups,
    migratedAutomations,
  };
}
