/**
 * Funções PURAS do agente — extraídas de `app/api/agent/process/route.ts`
 * pra serem testáveis em isolamento (sem DB, sem Gemini, sem efeito colateral).
 *
 * Mantêm o MESMO comportamento da rota. Qualquer mudança aqui afeta o agente
 * em produção — cobertas por `__tests__/agent-helpers.test.ts`.
 */

export type FunnelStage = {
  id?: string | number;
  title?: string;
  condition_variable?: string | null;
  condition_operator?: "equals" | "not_equals" | "contains" | null;
  condition_value?: string | null;
  [k: string]: any;
};

export type FunnelResolution = {
  activeStage: FunnelStage | null;
  currentStageIndex: number;
  skippedStages: number[];
};

export function sanitizeAgentAnswer(text: string): string {
  return text
    .trim()
    .replace(/^```\w*\r?\n?/g, "")
    .replace(/\r?\n?```$/g, "")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export type AgentOutputDecision =
  | { send: true; text: string }
  | { send: false; suppressed: "empty_output" | "tool_loop_exhausted" | "safety_classification" };

export function resolveAgentOutput(text: string, pendingToolCalls: number): AgentOutputDecision {
  if (pendingToolCalls > 0) return { send: false, suppressed: "tool_loop_exhausted" };
  const sanitized = sanitizeAgentAnswer(text);
  // ponytail: bloqueia rótulos conhecidos de moderadores; novas saídas técnicas exigem novos casos de teste.
  if (/(?:^|[\r\n{,])[\t "'`*_#>\-]*(?:user|response)[\t _]+safety["'`*_\t ]*:[\t "'`*_]*(?:safe|unsafe)\b/i.test(sanitized)) {
    return { send: false, suppressed: "safety_classification" };
  }
  return sanitized ? { send: true, text: sanitized } : { send: false, suppressed: "empty_output" };
}

export function sandboxSuppressionMessage(suppressed: unknown): string | null {
  if (suppressed === "empty_output") return "Resposta vazia suprimida. Nenhuma mensagem foi enviada.";
  if (suppressed === "tool_loop_exhausted") return "Limite de ferramentas atingido. Nenhuma mensagem foi enviada.";
  if (suppressed === "safety_classification") return "O modelo retornou uma classificação de segurança, não uma resposta de conversa. Nenhuma mensagem foi enviada. Verifique o modelo configurado; se estiver usando seleção automática, teste um modelo de chat específico.";
  return null;
}

/**
 * Avança pelas etapas do funil a partir de `startIndex`, pulando as que não
 * batem a condição (equals / not_equals / contains, case-insensitive) e
 * registrando os índices pulados. Para na 1ª etapa cuja condição é satisfeita.
 *
 * Pura: não muta os argumentos (clona skippedStages).
 */
export function resolveFunnelStage(
  leadStages: FunnelStage[] | null | undefined,
  currentVariables: Record<string, any>,
  startIndex: number,
  skippedStagesInput: number[] = []
): FunnelResolution {
  const skippedStages = [...skippedStagesInput];
  let currentStageIndex = startIndex;
  let activeStage: FunnelStage | null = null;

  if (leadStages && leadStages.length > 0) {
    while (currentStageIndex < leadStages.length) {
      const stage = leadStages[currentStageIndex];

      let conditionMet = true;
      if (stage.condition_variable && stage.condition_operator && stage.condition_value) {
        const varValue = String(currentVariables[stage.condition_variable] || "");
        const targetValue = String(stage.condition_value);
        if (stage.condition_operator === "equals") conditionMet = varValue.toLowerCase() === targetValue.toLowerCase();
        if (stage.condition_operator === "not_equals") conditionMet = varValue.toLowerCase() !== targetValue.toLowerCase();
        if (stage.condition_operator === "contains") conditionMet = varValue.toLowerCase().includes(targetValue.toLowerCase());
      }

      if (conditionMet) {
        activeStage = stage;
        break;
      } else {
        if (!skippedStages.includes(currentStageIndex)) skippedStages.push(currentStageIndex);
        currentStageIndex++;
      }
    }
  }

  return { activeStage, currentStageIndex, skippedStages };
}

/**
 * Verifica se o horário atual está FORA da escala (retorna true = FECHADO).
 * Usa America/Sao_Paulo fixo (servidor roda em UTC). `now` injetável pra teste.
 */
export function checkSchedulesSync(schedulesJSON: any, now: Date = new Date()): boolean {
  if (!schedulesJSON || !Array.isArray(schedulesJSON)) return false;
  const TZ = "America/Sao_Paulo";
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => fmt.find((p) => p.type === t)?.value || "";
  const dayMap: Record<string, string> = {
    Sun: "Domingo", Mon: "Segunda-feira", Tue: "Terça-feira", Wed: "Quarta-feira",
    Thu: "Quinta-feira", Fri: "Sexta-feira", Sat: "Sábado",
  };
  const currentDay = dayMap[get("weekday")] || "";
  const hh = String(Number(get("hour"))).padStart(2, "0");
  const currentTime = `${hh}:${get("minute")}`;

  const sched = schedulesJSON.find((s: any) => s.day === currentDay);
  if (!sched || !sched.active) return true; // sem escala no dia ou inativo = FECHADO
  if (currentTime < sched.start || currentTime > sched.end) return true; // fora da janela
  return false; // ABERTO
}

/** Intensidade do picote: 1 = picota pouco (mensagens maiores) · 5 = picota muito. */
export type SplitIntensity = 1 | 2 | 3 | 4 | 5;

export const DEFAULT_SPLIT_INTENSITY: SplitIntensity = 3;

interface SplitProfile {
  /** Também quebra em quebra de linha simples (não só parágrafo em branco). */
  splitOnLineBreak: boolean;
  /** Tamanho máximo de cada pedaço; acima disso quebra por frase. */
  maxLen: number;
  /** Junta pedaços vizinhos enquanto a soma couber nesse limite (0 = não junta). */
  mergeUpTo: number;
}

const SPLIT_PROFILES: Record<SplitIntensity, SplitProfile> = {
  1: { splitOnLineBreak: false, maxLen: 900, mergeUpTo: 700 },
  2: { splitOnLineBreak: false, maxLen: 600, mergeUpTo: 350 },
  3: { splitOnLineBreak: false, maxLen: 400, mergeUpTo: 0 },
  4: { splitOnLineBreak: true, maxLen: 220, mergeUpTo: 0 },
  5: { splitOnLineBreak: true, maxLen: 110, mergeUpTo: 0 },
};

/** Normaliza qualquer valor salvo (null, string, fora da faixa) para 1–5. */
export function normalizeSplitIntensity(value: unknown): SplitIntensity {
  const n = Math.round(Number(value));
  if (n >= 1 && n <= 5) return n as SplitIntensity;
  return DEFAULT_SPLIT_INTENSITY;
}

/**
 * Picota uma mensagem longa em pedaços lógicos (humanização).
 * Nível 3 (padrão) mantém o comportamento original: divide por parágrafos e
 * quebra por frase os pedaços > 400 chars. Níveis menores juntam parágrafos
 * (menos mensagens); níveis maiores quebram também por linha e por frase.
 */
export function splitMessage(text: string, intensity: SplitIntensity = DEFAULT_SPLIT_INTENSITY): string[] {
  if (!text) return [];
  const profile = SPLIT_PROFILES[normalizeSplitIntensity(intensity)];

  const separator = profile.splitOnLineBreak ? /\n+/ : /\n\n+/;
  const initialChunks = text.split(separator).map((c) => c.trim()).filter(Boolean);
  const pieces: string[] = [];

  for (const chunk of initialChunks) {
    if (chunk.length > profile.maxLen) {
      const sentences = chunk.split(/(?<=[.!?])\s+|\n/).map((s) => s.trim()).filter(Boolean);
      let temp = "";
      for (const s of sentences) {
        if ((temp.length + s.length) < profile.maxLen) {
          temp += (temp ? " " : "") + s;
        } else {
          if (temp) pieces.push(temp);
          temp = s;
        }
      }
      if (temp) pieces.push(temp);
    } else {
      pieces.push(chunk);
    }
  }

  if (profile.mergeUpTo <= 0) return pieces.filter((c) => c.length > 0);

  // Picote baixo: junta pedaços vizinhos para enviar menos mensagens.
  const merged: string[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.length + piece.length + 2 <= profile.mergeUpTo) {
      merged[merged.length - 1] = `${last}\n\n${piece}`;
    } else {
      merged.push(piece);
    }
  }
  return merged.filter((c) => c.length > 0);
}
