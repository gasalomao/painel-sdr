/**
 * src/types/goal-task-trigger.ts
 *
 * Tipos e helpers isomórficos (cliente/servidor) para o Gatilho de Tarefas por IA.
 * Não possui dependências do Node.js (fs, child_process, crypto, etc.),
 * podendo ser importado com segurança tanto em Client Components quanto em Server Components/APIs.
 */

export type GoalTaskDeadlineUnit = "business_days" | "days" | "hours";

export interface GoalTaskTriggerConfig {
  enabled: boolean;
  deadline_value: number;
  deadline_unit: GoalTaskDeadlineUnit;
  model: string;
  prompt: string;
}

export const DEFAULT_GOAL_TASK_PROMPT =
  "Você é um assistente operacional sênior. O agente SDR alcançou o objetivo com o lead (ex: aceitou proposta/prévia de site). Analise o histórico recente da conversa e crie um título/descrição de tarefa direto, objetivo e acionável para a equipe executar (ex: 'Entregar prévia do site para [Nome/Empresa] - focar em [detalhes combinados]'). Responda APENAS com o texto da tarefa, sem explicações ou introduções, com até 120 caracteres.";

export const DEFAULT_GOAL_TASK_CONFIG: GoalTaskTriggerConfig = {
  enabled: false,
  deadline_value: 2,
  deadline_unit: "business_days",
  model: "",
  prompt: DEFAULT_GOAL_TASK_PROMPT,
};

/**
 * Normaliza a configuração de gatilho salva no banco ou vinda da API.
 */
export function normalizeGoalTaskConfig(raw: unknown): GoalTaskTriggerConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_GOAL_TASK_CONFIG };
  }

  const obj = raw as Record<string, unknown>;
  const enabled = Boolean(obj.enabled);

  const rawVal = Number(obj.deadline_value);
  const deadline_value = Number.isFinite(rawVal) && rawVal >= 1
    ? Math.min(Math.floor(rawVal), 365)
    : DEFAULT_GOAL_TASK_CONFIG.deadline_value;

  const rawUnit = String(obj.deadline_unit || "").toLowerCase();
  const deadline_unit: GoalTaskDeadlineUnit =
    rawUnit === "hours" || rawUnit === "days" || rawUnit === "business_days"
      ? (rawUnit as GoalTaskDeadlineUnit)
      : "business_days";

  const model = typeof obj.model === "string" ? obj.model.trim() : "";
  const prompt = typeof obj.prompt === "string" && obj.prompt.trim()
    ? obj.prompt.trim().slice(0, 2000)
    : DEFAULT_GOAL_TASK_PROMPT;

  return {
    enabled,
    deadline_value,
    deadline_unit,
    model,
    prompt,
  };
}

/**
 * Calcula a data e hora de vencimento a partir do valor e unidade configurados.
 * Para `business_days`, pula sábados e domingos preservando o horário.
 */
export function calculateDueAt(
  value: number,
  unit: GoalTaskDeadlineUnit,
  baseDate: Date = new Date(),
): Date {
  const result = new Date(baseDate.getTime());
  const safeVal = Math.max(1, Math.floor(Number.isFinite(value) ? value : 1));

  if (unit === "hours") {
    result.setTime(result.getTime() + safeVal * 60 * 60 * 1000);
    return result;
  }

  if (unit === "days") {
    result.setTime(result.getTime() + safeVal * 24 * 60 * 60 * 1000);
    return result;
  }

  // business_days: avança dias pulando sábado (6) e domingo (0)
  let added = 0;
  while (added < safeVal) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) {
      added++;
    }
  }

  return result;
}

/**
 * Higieniza o texto gerado pela IA para garantir concisão e compatibilidade com dashboard_tasks.
 */
export function cleanGeneratedTaskText(rawText: string, fallbackLeadName?: string | null): string {
  let cleaned = (rawText || "").trim();

  // Remove aspas envolventes "..." ou '...'
  cleaned = cleaned.replace(/^["'“”«»]+|["'“”«»]+$/g, "").trim();

  // Remove prefixos redundantes como "Tarefa:", "Ação:", "Lembrete:"
  cleaned = cleaned.replace(/^(?:tarefa|ação|lembrete|task|action)\s*:\s*/i, "").trim();

  // Remove quebras de linha excessivas
  cleaned = cleaned.replace(/\s*[\r\n]+\s*/g, " - ").trim();

  // Remove formatação de negrito Markdown excessiva
  cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, "$1");

  if (!cleaned) {
    const leadTarget = fallbackLeadName ? `para ${fallbackLeadName}` : "com lead";
    return `Dar andamento à proposta/prévia ${leadTarget}`;
  }

  // Limite razoável para dashboard (máximo 500 caracteres)
  return cleaned.length > 500 ? cleaned.slice(0, 497) + "..." : cleaned;
}

