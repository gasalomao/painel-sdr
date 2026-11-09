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
 * Executa a avaliação binária ultra-leve do objetivo personalizado.
 *
 * Otimizações aplicadas:
 * 1. Curto-circuito com 0 tokens se o objetivo estiver vazio ou sem mensagens.
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
  const cleanGoal = (opts.goalText || "").trim().replace(/\s+/g, " ").slice(0, 240);
  if (!cleanGoal) {
    return { achieved: false, method: "skipped", tokensUsed: 0 };
  }

  const recent = (opts.messages || [])
    .filter((m) => m && typeof m.content === "string" && m.content.trim().length > 0)
    .slice(-4);

  if (recent.length === 0) {
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

  const targetModel =
    opts.modelRef && opts.modelRef.trim().length > 0
      ? opts.modelRef.trim()
      : process.env.DEFAULT_FAST_MODEL || "gemini-2.0-flash";

  try {
    const { generateText } = await import("@/lib/ai-provider");
    const aiRes = await generateText({
      modelRef: targetModel,
      system: CUSTOM_GOAL_EVAL_SYSTEM_PROMPT,
      prompt,
      temperature: 0,
      maxOutputTokens: 5,
      reasoningMode: 0,
      geminiApiKey: opts.geminiApiKey,
      openrouterApiKey: opts.openrouterApiKey,
      nvidiaApiKey: opts.nvidiaApiKey,
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

