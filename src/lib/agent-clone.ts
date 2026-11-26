import { supabaseAdmin } from "@/lib/supabase_admin";
import { invalidateAgentConfigCache } from "@/lib/agent-config-cache";
import { assertTenantCanCreateAgent, assertTenantCanCreateInstance } from "@/lib/saas-limits";

export interface CloneAgentParams {
  clientId: string;
  sourceAgentId: number;
  newName: string;
  targetInstanceName?: string | null;
  cloneKnowledge?: boolean;
  cloneStages?: boolean;
  cloneCalendarConfig?: boolean;
  cloneAutomation?: boolean;
  isAdmin?: boolean;
}

export interface CloneAgentResult {
  ok: boolean;
  status: number;
  error?: string;
  agent?: Record<string, unknown>;
  clonedKnowledgeCount?: number;
  clonedStagesCount?: number;
  clonedAutomationsCount?: number;
  boundInstance?: string | null;
}

const CALENDAR_OPTION_KEYS = [
  "google_tokens",
  "google_credentials",
  "calendar_connected_email",
  "calendar_id",
  "calendar_enabled",
] as const;

/**
 * Clona qualquer agente do tenant (Sarah ou agente customizado), replicando
 * prompt, modelo, buffers, delays, base de conhecimento e etapas do funil,
 * permitindo vincular imediatamente um número de WhatsApp distinto sem apagar conexões existentes.
 */
export async function cloneAgentForClient(params: CloneAgentParams): Promise<CloneAgentResult> {
  const {
    clientId,
    sourceAgentId,
    newName,
    targetInstanceName,
    cloneKnowledge = true,
    cloneStages = true,
    cloneCalendarConfig = false,
    cloneAutomation = false,
    isAdmin = false,
  } = params;

  const trimmedName = String(newName || "").trim();
  if (!clientId || !sourceAgentId || !trimmedName) {
    return { ok: false, status: 400, error: "source_agent_id e new_name são obrigatórios." };
  }
  if (!supabaseAdmin) {
    return { ok: false, status: 500, error: "Banco de dados indisponível." };
  }

  const quotaErr = await assertTenantCanCreateAgent(clientId, isAdmin);
  if (quotaErr) {
    const body = (await quotaErr.json().catch(() => ({ error: "Limite de agentes atingido" }))) as { error?: string };
    return { ok: false, status: quotaErr.status || 403, error: body.error || "Limite de agentes atingido" };
  }

  const { data: sourceRow, error: sourceErr } = await supabaseAdmin
    .from("agent_settings")
    .select("*")
    .eq("id", sourceAgentId)
    .eq("client_id", clientId)
    .maybeSingle();

  if (sourceErr || !sourceRow) {
    return { ok: false, status: 404, error: "Agente de origem não encontrado neste cliente." };
  }

  const cleanTargetInstance = targetInstanceName ? String(targetInstanceName).trim() : "";
  if (cleanTargetInstance) {
    const { data: existingConn } = await supabaseAdmin
      .from("channel_connections")
      .select("client_id, instance_name")
      .eq("instance_name", cleanTargetInstance)
      .maybeSingle();

    if (existingConn && existingConn.client_id && existingConn.client_id !== clientId) {
      return { ok: false, status: 403, error: "Esta instância pertence a outro cliente." };
    }
    if (!existingConn) {
      const instErr = await assertTenantCanCreateInstance(clientId, isAdmin);
      if (instErr) {
        const body = (await instErr.json().catch(() => ({ error: "Limite de instâncias atingido" }))) as { error?: string };
        return { ok: false, status: instErr.status || 403, error: body.error || "Limite de instâncias atingido" };
      }
    }
  }

  const clonedPayload: Record<string, unknown> = { ...(sourceRow as Record<string, unknown>) };
  delete clonedPayload.id;
  delete clonedPayload.created_at;
  delete clonedPayload.updated_at;
  clonedPayload.name = trimmedName;
  clonedPayload.client_id = clientId;
  clonedPayload.main_number = cleanTargetInstance || null;

  const rawOpts =
    clonedPayload.options && typeof clonedPayload.options === "object"
      ? { ...(clonedPayload.options as Record<string, unknown>) }
      : {};

  if (!cloneCalendarConfig) {
    for (const calKey of CALENDAR_OPTION_KEYS) {
      delete rawOpts[calKey];
    }
  }
  clonedPayload.options = rawOpts;

  const { data: insertedAgent, error: insertErr } = await supabaseAdmin
    .from("agent_settings")
    .insert(clonedPayload)
    .select("*")
    .single();

  if (insertErr || !insertedAgent) {
    return { ok: false, status: 500, error: insertErr?.message || "Falha ao clonar agente." };
  }

  const newAgentId = Number((insertedAgent as { id: number }).id);
  let clonedKnowledgeCount = 0;
  let clonedStagesCount = 0;
  let clonedAutomationsCount = 0;

  if (cloneKnowledge) {
    const { data: kbRows } = await supabaseAdmin
      .from("agent_knowledge")
      .select("title, content")
      .eq("agent_id", sourceAgentId)
      .or(`client_id.eq.${clientId},client_id.is.null`);

    if (Array.isArray(kbRows) && kbRows.length > 0) {
      const inserts = kbRows.map((row) => ({
        agent_id: newAgentId,
        client_id: clientId,
        title: String((row as { title?: string }).title || "Conhecimento"),
        content: (row as { content?: string | null }).content ?? null,
      }));
      const { error: kbErr } = await supabaseAdmin.from("agent_knowledge").insert(inserts);
      if (!kbErr) clonedKnowledgeCount = inserts.length;
    }
  }

  if (cloneStages) {
    const { data: stageRows } = await supabaseAdmin
      .from("agent_stages")
      .select("title, goal_prompt, order_index, condition_variable, condition_operator, condition_value, captured_variables")
      .eq("agent_id", sourceAgentId)
      .eq("client_id", clientId)
      .order("order_index", { ascending: true });

    if (Array.isArray(stageRows) && stageRows.length > 0) {
      const inserts = stageRows.map((row) => ({
        ...(row as Record<string, unknown>),
        agent_id: newAgentId,
        client_id: clientId,
      }));
      const { error: stErr } = await supabaseAdmin.from("agent_stages").insert(inserts);
      if (!stErr) clonedStagesCount = inserts.length;
    }
  }

  if (cloneAutomation) {
    try {
      const { data: autoRows } = await supabaseAdmin
        .from("automations")
        .select("*")
        .eq("client_id", clientId)
        .eq("agent_id", sourceAgentId);

      if (Array.isArray(autoRows) && autoRows.length > 0) {
        for (const auto of autoRows as Array<Record<string, unknown>>) {
          const copy = { ...auto };
          delete copy.id;
          delete copy.created_at;
          delete copy.updated_at;
          copy.agent_id = newAgentId;
          copy.name = `${String(auto.name || "Automação")} (${trimmedName})`;
          copy.instance_name = cleanTargetInstance || String(auto.instance_name || "");
          copy.enabled = false;
          if ("status" in copy) copy.status = "paused";
          const { error: autoErr } = await supabaseAdmin.from("automations").insert(copy);
          if (!autoErr) clonedAutomationsCount += 1;
        }
      }
    } catch { /* tabela opcional */ }
  }

  let boundInstance: string | null = null;
  if (cleanTargetInstance) {
    const { data: connExisting } = await supabaseAdmin
      .from("channel_connections")
      .select("agent_id")
      .eq("instance_name", cleanTargetInstance)
      .maybeSingle();

    const { error: bindErr } = await supabaseAdmin
      .from("channel_connections")
      .upsert(
        {
          instance_name: cleanTargetInstance,
          agent_id: newAgentId,
          client_id: clientId,
          status: "open",
        },
        { onConflict: "instance_name" }
      );
    if (!bindErr) {
      boundInstance = cleanTargetInstance;
      if (connExisting?.agent_id && Number(connExisting.agent_id) !== newAgentId) {
        invalidateAgentConfigCache(Number(connExisting.agent_id));
      }
    }
  }

  invalidateAgentConfigCache(newAgentId);

  return {
    ok: true,
    status: 200,
    agent: insertedAgent as Record<string, unknown>,
    clonedKnowledgeCount,
    clonedStagesCount,
    clonedAutomationsCount,
    boundInstance,
  };
}
