/**
 * src/lib/goal-task-generator.ts
 *
 * Gerador automático de tarefas executivas disparado quando o Agente SDR
 * atinge o seu Objetivo Personalizado (ex: cliente aceitou prévia de site/reunião).
 *
 * - Multi-tenant estrito (client_id).
 * - Anti-duplicidade em retentativas/webhooks (dedup janela 24h por lead).
 * - Cálculo inteligente de prazo (SLA): dias úteis (pula fins de semana), corridos ou horas.
 * - Integração limpa com `generateText` (@/lib/ai-provider).
 */

import { supabaseAdmin } from "@/lib/supabase_admin";
import { generateText } from "@/lib/ai-provider";
import {
  calculateDueAt,
  cleanGeneratedTaskText,
  normalizeGoalTaskConfig,
  type GoalTaskDeadlineUnit,
  type GoalTaskTriggerConfig,
} from "@/types/goal-task-trigger";

export * from "@/types/goal-task-trigger";

export interface GenerateGoalTaskParams {
  clientId: string;
  leadId?: number | null;
  remoteJid: string;
  goalText: string;
  conversationHistory?: Array<{ role: "user" | "agent"; content: string }>;
  contactName?: string | null;
  businessName?: string | null;
  agentName?: string | null;
  baseDate?: Date;
}

export interface GenerateGoalTaskResult {
  created: boolean;
  reason?: string;
  taskId?: string;
  text?: string;
  dueAt?: string;
  leadId?: number | null;
}

/**
 * Executa o fluxo de geração automática de tarefa a partir de objetivo alcançado.
 */
export async function triggerGoalTaskGeneration(
  params: GenerateGoalTaskParams,
): Promise<GenerateGoalTaskResult> {
  const {
    clientId,
    remoteJid,
    goalText,
    conversationHistory = [],
    contactName,
    businessName,
    baseDate = new Date(),
  } = params;

  if (!clientId || !supabaseAdmin) {
    return { created: false, reason: "missing_client_or_db" };
  }

  // 1. Carrega configuração do cliente (features.goal_task_trigger)
  const { data: clientRow, error: clientErr } = await supabaseAdmin
    .from("clients")
    .select("features, default_ai_model")
    .eq("id", clientId)
    .maybeSingle();

  if (clientErr) {
    console.warn("[GOAL_TASK] Erro ao buscar configuração do cliente:", clientErr.message);
    return { created: false, reason: "client_query_error" };
  }

  const rawFeatures = (clientRow?.features ?? {}) as Record<string, unknown>;
  const config = normalizeGoalTaskConfig(rawFeatures.goal_task_trigger);

  if (!config.enabled) {
    return { created: false, reason: "disabled" };
  }

  // 2. Resolve lead_id se não fornecido
  let resolvedLeadId = params.leadId ?? null;
  let resolvedBusinessName = businessName ?? null;

  if (resolvedLeadId === null && remoteJid) {
    try {
      const { data: leadFound } = await supabaseAdmin
        .from("leads_extraidos")
        .select("id, nome_negocio")
        .eq("client_id", clientId)
        .eq("remoteJid", remoteJid)
        .maybeSingle();

      if (leadFound) {
        resolvedLeadId = leadFound.id;
        if (!resolvedBusinessName && leadFound.nome_negocio) {
          resolvedBusinessName = leadFound.nome_negocio;
        }
      }
    } catch {
      // Best effort lookup
    }
  }

  // 3. Prevenção de duplicidade: checar se já existe tarefa pendente criada nas últimas 24h
  if (resolvedLeadId !== null) {
    try {
      const since24h = new Date(baseDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const { data: recentTasks } = await supabaseAdmin
        .from("dashboard_tasks")
        .select("id")
        .eq("client_id", clientId)
        .eq("lead_id", resolvedLeadId)
        .is("completed_at", null)
        .gte("created_at", since24h)
        .limit(1);

      if (recentTasks && recentTasks.length > 0) {
        console.log(`[GOAL_TASK] Tarefa já existente para lead ${resolvedLeadId} nas últimas 24h. Pulando.`);
        return { created: false, reason: "duplicate_recent_task", leadId: resolvedLeadId };
      }
    } catch (dedupErr: any) {
      console.warn("[GOAL_TASK] Aviso ao verificar dedup de tarefas:", dedupErr?.message);
    }
  }

  // 4. Formata contexto e diálogo recente para a IA
  const leadContextLabel = resolvedBusinessName || contactName || "Lead sem identificação";
  const recentDialog = conversationHistory.slice(-8).map((m) => {
    const speaker = m.role === "user" ? "Cliente" : "SDR";
    return `${speaker}: ${m.content}`;
  }).join("\n");

  const promptUser = `Lead / Empresa: ${leadContextLabel}
Objetivo cumprido: "${goalText}"

Histórico recente da conversa:
${recentDialog || "(Sem histórico recente adicional)"}

Instrução: Gere o título executivo da tarefa para nossa equipe atender esse lead.`;

  // 5. Executa a chamada à IA
  let taskText = "";
  try {
    const targetModel = config.model || clientRow?.default_ai_model || "gemini:gemini-2.5-flash";
    const aiRes = await generateText({
      modelRef: targetModel,
      system: config.prompt,
      prompt: promptUser,
      temperature: 0.2,
      reasoningMode: 0,
    });
    taskText = cleanGeneratedTaskText(aiRes.text, leadContextLabel);
  } catch (aiErr: any) {
    console.warn("[GOAL_TASK] Falha na IA ao gerar texto da tarefa, usando fallback:", aiErr?.message);
    taskText = cleanGeneratedTaskText("", leadContextLabel);
  }

  // 6. Calcula a data de entrega (SLA)
  const dueAtDate = calculateDueAt(config.deadline_value, config.deadline_unit, baseDate);
  const dueAtIso = dueAtDate.toISOString();

  // 7. Insere na tabela `dashboard_tasks`
  const { data: insertedTask, error: insertErr } = await supabaseAdmin
    .from("dashboard_tasks")
    .insert({
      client_id: clientId,
      lead_id: resolvedLeadId,
      text: taskText,
      due_at: dueAtIso,
      completed_at: null,
    })
    .select("id, text, due_at, lead_id, created_at")
    .maybeSingle();

  if (insertErr) {
    console.warn("[GOAL_TASK] Erro ao inserir tarefa gerada:", insertErr.message);
    return { created: false, reason: "insert_error" };
  }

  // 8. Log de auditoria em webhook_logs
  supabaseAdmin.from("webhook_logs").insert({
    client_id: clientId,
    event: "AGENT_GOAL_TASK_CREATED",
    payload: {
      task_id: insertedTask?.id,
      text: taskText,
      due_at: dueAtIso,
      lead_id: resolvedLeadId,
      goal: goalText,
      deadline_value: config.deadline_value,
      deadline_unit: config.deadline_unit,
    },
    created_at: new Date().toISOString(),
  }).then(() => {}, () => {});

  console.log(`[GOAL_TASK] Tarefa automática criada com sucesso: "${taskText}" (Vencimento: ${dueAtIso})`);

  return {
    created: true,
    taskId: insertedTask?.id,
    text: taskText,
    dueAt: dueAtIso,
    leadId: resolvedLeadId,
  };
}

