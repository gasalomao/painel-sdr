/**
 * src/lib/custom-goal-evaluator.ts
 *
 * Avaliador secundário ultra-otimizado de Objetivo Personalizado para Agentes de IA.
 *
 * Projetado para gastar o mínimo absoluto de tokens (~80 a 140 tokens de entrada
 * e 1 token de saída: "SIM" ou "NAO", com reasoningMode=0 e temperature=0),
 * verificando se o objetivo livre definido pelo usuário foi alcançado no turno.
 */

import type { AiProvider, AiUsage } from "@/lib/ai-provider";

export type CustomGoalPauseMode = "timed" | "indefinite";

export interface CustomGoalConfig {
  enabled: boolean;
  goalText: string;
  pauseMode: CustomGoalPauseMode;
  pauseMinutes: number;
}

export interface CustomGoalMessage {
  role: "user" | "agent";
  content: string;
}

export interface CustomGoalEvaluationResult {
  achieved: boolean;
  method: "ai" | "skipped" | "error";
  tokensUsed: number;
  usage?: AiUsage;
  modelUsed?: string;
  provider?: AiProvider;
}

export const DEFAULT_CUSTOM_GOAL_PAUSE_MINUTES = 30;

/**
 * Prompt de sistema ultra-enxuto (~38 tokens) para classificação binária de 1 token.
 * C = Cliente, A = Atendente (IA).
 */
export const CUSTOM_GOAL_EVAL_SYSTEM_PROMPT =
  "Avaliador binário. Analise o diálogo (C=Cliente, A=Atendente) e decida se o OBJETIVO já foi efetivamente cumprido. Responda APENAS uma palavra: SIM ou NAO.";

/**
 * Normaliza a configuração de Objetivo Personalizado salva em `agent_settings.options`.
 */
export function normalizeCustomGoalConfig(
  raw: Record<string, unknown> | null | undefined,
): CustomGoalConfig {
  if (!raw || typeof raw !== "object") {
    return {
      enabled: false,
      goalText: "",
      pauseMode: "timed",
      pauseMinutes: DEFAULT_CUSTOM_GOAL_PAUSE_MINUTES,
    };
  }

  const enabled = Boolean(raw.custom_goal_enabled);
  const goalText = typeof raw.custom_goal_text === "string" ? raw.custom_goal_text.trim() : "";

  const rawMode = String(raw.custom_goal_pause_mode ?? "timed").trim().toLowerCase();
  const pauseMode: CustomGoalPauseMode =
    rawMode === "indefinite" || rawMode === "manual" || rawMode === "forever"
      ? "indefinite"
      : "timed";

  const parsedMinutes = Number(raw.custom_goal_pause_minutes);
  const pauseMinutes =
    Number.isFinite(parsedMinutes) && parsedMinutes >= 1
      ? Math.min(Math.floor(parsedMinutes), 43_200) // máx 30 dias em minutos
      : DEFAULT_CUSTOM_GOAL_PAUSE_MINUTES;

  return {
    enabled,
    goalText,
    pauseMode,
    pauseMinutes,
  };
}

/**
 * Interpreta a resposta curta da IA avaliadora ("SIM" / "NAO").
 */
export function parseBinaryGoalResponse(rawText: string): boolean {
  const cleaned = (rawText || "").trim();
  if (!cleaned) return false;

  // Caso algum modelo devolva JSON mesmo pedindo 1 palavra
  if (cleaned.startsWith("{")) {
    try {
      const parsed = JSON.parse(cleaned) as Record<string, unknown>;
      if (typeof parsed.achieved === "boolean") return parsed.achieved;
      if (typeof parsed.atingido === "boolean") return parsed.atingido;
      if (typeof parsed.ok === "boolean") return parsed.ok;
    } catch {
      // Continua para o parser textual
    }
  }

  const firstToken = cleaned
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z]/g, " ")
    .trim()
    .split(/\s+/)[0] || "";

  if (firstToken === "NAO" || firstToken === "NO" || firstToken === "FALSE" || firstToken === "N") {
    return false;
  }

  return firstToken === "SIM" || firstToken === "S" || firstToken === "YES" || firstToken === "TRUE";
}

/**
 * Respostas puras de espera em fila/URA onde o agente apenas aguarda transferência
 * humana sem ter alcançado um objetivo de agendamento ou fechamento.
 */
const PURE_QUEUE_HOLD_AGENT_REGEX =
  /^(?:(?:combinado|perfeito|certo|beleza|show|entendido|ok|tudo\s+bem|tranquilo|sem\s+problemas?)[,!.\s]*)?(?:eu\s+)?(?:fico|estou|vou\s+ficar|aguardo)\s+(?:no\s+aguardo|aguardando(?:\s+(?:por\s+aqui|o\s+retorno|voc[eê]s?|a\s+equipe|o\s+atendimento))?)(?:\s+o\s+retorno)?(?:\s+por\s+aqui)?[!.\s😊👍🙏]*$/i;

/**
 * Detecta quando o próprio texto do objetivo proíbe explicitamente pausar se a IA
 * ainda fez uma pergunta ao cliente.
 */
const GOAL_FORBIDS_QUESTION_PAUSE_REGEX =
  /(?:nunca|n[aã]o)\s+pausar[^.\n]*pergunta|sem\s+(?:nenhuma\s+)?pergunta/i;

function endsWithOpenQuestion(text: string): boolean {
  const cleaned = (text || "")
    .replace(/[\s"'”’)\]}>\u{1F300}-\u{1FAFF}\u2600-\u27BF]+$/gu, "")
    .trim();
  if (cleaned.endsWith("?")) return true;
  // Cobre casos como "Vocês têm Instagram? Fico no aguardo!"
  const tail = cleaned.slice(-160);
  return tail.includes("?");
}

function shouldSkipGoalEvalDeterministically(
  cleanGoal: string,
  recent: CustomGoalMessage[],
): boolean {
  const lastAgentMsg = [...recent].reverse().find((m) => m.role === "agent");
  if (!lastAgentMsg) return false;

  const agentText = lastAgentMsg.content.trim();
  if (!agentText) return false;

  if (PURE_QUEUE_HOLD_AGENT_REGEX.test(agentText)) {
    return true;
  }

  if (GOAL_FORBIDS_QUESTION_PAUSE_REGEX.test(cleanGoal) && endsWithOpenQuestion(agentText)) {
    return true;
  }

  return false;
}

/**
 * Executa a avaliação binária ultra-leve do objetivo personalizado.
 *
 * Otimizações aplicadas:
 * 1. Curto-circuito com 0 tokens se o objetivo estiver vazio, sem mensagens,
 *    em resposta pura de espera em URA/fila ou com pergunta aberta proibida pelo objetivo.
 * 2. Janela máxima de 4 mensagens (últimos 2 turnos), truncadas em 220 caracteres cada.
 * 3. `reasoningMode: 0` (zero gasto com thinking tokens ocultos).
 * 4. `maxOutputTokens: 5` e `temperature: 0` (resposta determinística de 1 token: SIM/NAO).
 */
export async function evaluateCustomGoal(opts: {
  goalText: string;
  messages: CustomGoalMessage[];
  modelRef?: string | null;
  geminiApiKey?: string | null;
  openrouterApiKey?: string | null;
  nvidiaApiKey?: string | null;
}): Promise<CustomGoalEvaluationResult> {
  const cleanGoal = (opts.goalText || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 2000);
  if (!cleanGoal) {
    return { achieved: false, method: "skipped", tokensUsed: 0 };
  }

  const recent = (opts.messages || [])
    .filter((m) => m && typeof m.content === "string" && m.content.trim().length > 0)
    .slice(-4);

  if (recent.length === 0) {
    return { achieved: false, method: "skipped", tokensUsed: 0 };
  }

  if (shouldSkipGoalEvalDeterministically(cleanGoal, recent)) {
    return { achieved: false, method: "skipped", tokensUsed: 0 };
  }

  const formattedDialogue = recent
    .map((m) => {
      const tag = m.role === "user" ? "C" : "A";
      const snippet = m.content.trim().replace(/\s+/g, " ").slice(0, 220);
      return `${tag}: ${snippet}`;
    })
    .join("\n");

  const prompt = `OBJETIVO: ${cleanGoal}\n\nDIALOGO:\n${formattedDialogue}\n\nCumprido? (SIM/NAO):`;

  let targetModel =
    opts.modelRef && opts.modelRef.trim().length > 0
      ? opts.modelRef.trim()
      : process.env.DEFAULT_FAST_MODEL || "";
  let resolvedGeminiKey = opts.geminiApiKey;
  let resolvedOpenRouterKey = opts.openrouterApiKey;
  let resolvedNvidiaKey = opts.nvidiaApiKey;
  if (!targetModel) {
    try {
      const { cheapModelForSummary } = await import("@/lib/history-summary");
      const cheap = await cheapModelForSummary({
        geminiApiKey: opts.geminiApiKey,
        openrouterApiKey: opts.openrouterApiKey,
        nvidiaApiKey: opts.nvidiaApiKey,
      });
      targetModel = cheap?.modelRef || "gemini-2.0-flash";
      resolvedGeminiKey = resolvedGeminiKey ?? cheap?.geminiApiKey;
      resolvedOpenRouterKey = resolvedOpenRouterKey ?? cheap?.openrouterApiKey;
      resolvedNvidiaKey = resolvedNvidiaKey ?? cheap?.nvidiaApiKey;
    } catch {
      targetModel = "gemini-2.0-flash";
    }
  }

  try {
    const { generateText } = await import("@/lib/ai-provider");
    const aiRes = await generateText({
      modelRef: targetModel,
      system: CUSTOM_GOAL_EVAL_SYSTEM_PROMPT,
      prompt,
      temperature: 0,
      maxOutputTokens: 5,
      reasoningMode: 0,
      taskProfile: "fast",
      geminiApiKey: resolvedGeminiKey,
      openrouterApiKey: resolvedOpenRouterKey,
      nvidiaApiKey: resolvedNvidiaKey,
    });

    const achieved = parseBinaryGoalResponse(aiRes.text);
    return {
      achieved,
      method: "ai",
      tokensUsed: aiRes.usage?.totalTokens ?? 0,
      usage: aiRes.usage,
      modelUsed: aiRes.modelUsed,
      provider: aiRes.provider,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[custom-goal-evaluator] Falha ao avaliar objetivo personalizado:", msg);
    return {
      achieved: false,
      method: "error",
      tokensUsed: 0,
    };
  }
}

