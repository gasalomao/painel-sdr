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
  const hh = get("hour") === "24" ? "00" : get("hour");
  const currentTime = `${hh}:${get("minute")}`;

  const sched = schedulesJSON.find((s: any) => s.day === currentDay);
  if (!sched || !sched.active) return true; // sem escala no dia ou inativo = FECHADO
  if (currentTime < sched.start || currentTime > sched.end) return true; // fora da janela
  return false; // ABERTO
}

/**
 * Picota uma mensagem longa em pedaços lógicos (humanização). Divide por
 * parágrafos; pedaços > 400 chars são quebrados por frase.
 */
export function splitMessage(text: string): string[] {
  if (!text) return [];

  const initialChunks = text.split(/\n\n+/).map((c) => c.trim()).filter(Boolean);
  const finalChunks: string[] = [];

  for (const chunk of initialChunks) {
    if (chunk.length > 400) {
      const sentences = chunk.split(/(?<=[.!?])\s+|\n/).map((s) => s.trim()).filter(Boolean);
      let temp = "";
      for (const s of sentences) {
        if ((temp.length + s.length) < 400) {
          temp += (temp ? " " : "") + s;
        } else {
          if (temp) finalChunks.push(temp);
          temp = s;
        }
      }
      if (temp) finalChunks.push(temp);
    } else {
      finalChunks.push(chunk);
    }
  }

  return finalChunks.filter((c) => c.length > 0);
}
