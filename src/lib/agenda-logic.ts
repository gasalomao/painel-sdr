/**
 * Lógica PURA de agendamento — extraída de agent/process, appointment-worker e
 * das rotas /api/appointments pra ser testável em isolamento (sem DB, sem
 * Google, sem efeito colateral). Agendamento é crítico: estas funções
 * concentram as decisões e são cobertas por `__tests__/agenda-logic.test.ts`.
 *
 * Qualquer mudança aqui muda o comportamento real do agendamento em produção.
 */

/**
 * Converte o `start_datetime` que a IA manda (geralmente "naive", sem fuso, ex
 * "2026-06-01T10:00:00") num instante no fuso de Brasília (America/Sao_Paulo,
 * -03:00). Se já vier com offset (Z ou ±HH:MM), respeita.
 *
 * Bug que isto corrige: num servidor UTC, `new Date("2026-06-01T10:00:00")` era
 * lido como 10:00 UTC → o dono (BRT) via 07:00. Agora 10:00 "naive" = 10:00 BRT.
 */
export function parseAgendaDateTime(raw: string): Date {
  const s = String(raw || "").trim();
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  return new Date(hasTz ? s : `${s}-03:00`);
}

/** True se a string tem um offset de fuso explícito (Z ou ±HH:MM). */
export function hasExplicitTimezone(raw: string): boolean {
  return /[zZ]$|[+-]\d{2}:?\d{2}$/.test(String(raw || "").trim());
}

export type SlotRow = { start_at: string };

/**
 * Anti-duplicação: o MESMO contato já tem um agendamento confirmado no MESMO
 * horário (±tolerância). Pega o caso real de triplo-agendamento (cliente manda
 * "ok/combinado/obrigada" e a IA re-chama a tool). NÃO bloqueia horário
 * diferente — isso é remarcação, tratada à parte.
 */
export function isDuplicateSlot(
  existing: SlotRow[] | null | undefined,
  startMs: number,
  toleranceMs: number = 2 * 60_000
): boolean {
  if (!existing) return false;
  return existing.some((r) => {
    const t = new Date(r.start_at).getTime();
    return Number.isFinite(t) && Math.abs(t - startMs) <= toleranceMs;
  });
}

/**
 * Conflito de slot por OUTRO contato: o mesmo agente já tem um agendamento
 * ativo naquele horário exato pra um número diferente. Não conta o próprio
 * contato (isso é duplicação, não conflito).
 */
export function hasOtherContactConflict(
  slotRows: { remote_jid: string }[] | null | undefined,
  remoteJid: string
): boolean {
  if (!slotRows) return false;
  return slotRows.some((r) => r.remote_jid && r.remote_jid !== remoteJid);
}

/** True se o horário mudou entre dois ISO (usado pra zerar reminders_sent). */
export function startChanged(oldIso: string, newIso: string): boolean {
  const a = new Date(oldIso).getTime();
  const b = new Date(newIso).getTime();
  return a !== b;
}

/* ============================================================
   RECORRÊNCIA — RRULE do Google Calendar
   ============================================================ */

export type RecurrenceFrequency = "NONE" | "DAILY" | "WEEKLY" | "MONTHLY";

export type RecurrenceEnd =
  | { type: "never" }
  | { type: "count"; count: number }
  | { type: "until"; date: string }; // YYYY-MM-DD

export type RecurrenceSpec = {
  frequency: RecurrenceFrequency;
  interval: number;
  end: RecurrenceEnd;
};

export const DEFAULT_RECURRENCE: RecurrenceSpec = {
  frequency: "NONE",
  interval: 1,
  end: { type: "never" },
};

/**
 * Converte a spec da UI no array RRULE aceito pelo Google Calendar.
 * Ex.: { frequency: "WEEKLY", interval: 2, end: { type: "count", count: 10 } }
 *   → ["RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=10"]
 * "NONE" → [] (sem recorrência).
 */
export function buildRecurrenceRule(spec: RecurrenceSpec): string[] {
  if (!spec || spec.frequency === "NONE") return [];
  const interval = Math.max(1, Math.floor(spec.interval || 1));
  const parts = [`FREQ=${spec.frequency}`];
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (spec.end?.type === "count") {
    const count = Math.max(1, Math.floor(spec.end.count || 1));
    parts.push(`COUNT=${count}`);
  } else if (spec.end?.type === "until" && /^\d{4}-\d{2}-\d{2}$/.test(spec.end.date)) {
    parts.push(`UNTIL=${spec.end.date.replace(/-/g, "")}T235959Z`);
  }
  return [`RRULE:${parts.join(";")}`];
}

/**
 * Lê o RRULE gravado (column `recurrence` text[]) de volta pra spec da UI.
 * Retorna null quando não há RRULE ou quando a frequência não é suportada.
 */
export function parseRecurrenceRule(rules: string[] | null | undefined): RecurrenceSpec | null {
  const rule = (rules || []).find((r) => typeof r === "string" && r.toUpperCase().startsWith("RRULE:"));
  if (!rule) return null;
  const map = new Map<string, string>();
  for (const part of rule.slice(rule.indexOf(":") + 1).split(";")) {
    const [k, v] = part.split("=");
    if (k && v) map.set(k.trim().toUpperCase(), v.trim());
  }
  const freq = (map.get("FREQ") || "").toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY") return null;
  const rawInterval = Number(map.get("INTERVAL") || 1);
  let end: RecurrenceEnd = { type: "never" };
  if (map.get("COUNT")) {
    end = { type: "count", count: Math.max(1, Math.floor(Number(map.get("COUNT")) || 1)) };
  } else if (map.get("UNTIL")) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(map.get("UNTIL")!);
    if (m) end = { type: "until", date: `${m[1]}-${m[2]}-${m[3]}` };
  }
  return {
    frequency: freq as RecurrenceFrequency,
    interval: Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 1,
    end,
  };
}

/**
 * Decide se um lembrete (offset X min antes) deve disparar AGORA.
 * Espelha 1:1 o gate do worker tickReminders:
 *   - só agendamento 'confirmed';
 *   - ainda não enviado esse offset;
 *   - já passou do horário de disparo (start - offset);
 *   - mas a reunião ainda não começou (now < start).
 */
export function shouldSendReminder(opts: {
  status: string;
  startMs: number;
  nowMs: number;
  offsetMinutes: number;
  alreadySent: boolean;
}): boolean {
  if (opts.status !== "confirmed") return false;
  if (opts.alreadySent) return false;
  if (!Number.isFinite(opts.offsetMinutes) || opts.offsetMinutes <= 0) return false;
  const dueAt = opts.startMs - opts.offsetMinutes * 60_000;
  if (opts.nowMs < dueAt) return false;       // ainda não chegou a hora do lembrete
  if (opts.nowMs >= opts.startMs) return false; // reunião já começou
  return true;
}

/** Chave de idempotência do lembrete (offset → "60min"). */
export function reminderKey(offsetMinutes: number): string {
  return `${offsetMinutes}min`;
}

/** Dois intervalos [aStart,aEnd) e [bStart,bEnd) se sobrepõem? (meia-aberto) */
export function rangesOverlap(aStartMs: number, aEndMs: number, bStartMs: number, bEndMs: number): boolean {
  return aStartMs < bEndMs && bStartMs < aEndMs;
}

export type BusyRow = { remote_jid?: string; start_at: string; end_at: string };

/**
 * Disponibilidade: o intervalo [startMs,endMs) do agente CONFLITA com algum
 * agendamento ativo de OUTRO contato? Cobre sobreposição parcial (não só
 * horário idêntico). Ignora o próprio contato (ownRemoteJid) — remarcar pro
 * mesmo cliente não conflita consigo mesmo. Datas inválidas são ignoradas.
 */
export function hasAgentOverlapConflict(
  rows: BusyRow[] | null | undefined,
  startMs: number,
  endMs: number,
  ownRemoteJid?: string
): boolean {
  if (!rows) return false;
  return rows.some((r) => {
    if (ownRemoteJid && r.remote_jid === ownRemoteJid) return false;
    const s = new Date(r.start_at).getTime();
    const e = new Date(r.end_at).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
    return rangesOverlap(startMs, endMs, s, e);
  });
}

export type FreeSlotsOptions = {
  /** Data no formato YYYY-MM-DD */
  targetDate: string;
  /** Intervalos ocupados (do Google Calendar e/ou appointments do banco) */
  busyRanges?: Array<{ start: Date | string | number; end: Date | string | number }>;
  /** Duração da reunião em minutos (padrão: 30) */
  durationMinutes?: number;
  /** Início do expediente (hora cheia, padrão: 8 -> 08:00) */
  startHour?: number;
  /** Fim do expediente (hora cheia, padrão: 18 -> 18:00) */
  endHour?: number;
  /** Passo entre horários sugeridos em minutos (padrão: 30) */
  stepMinutes?: number;
  /** Data de referência atual para filtrar horários do passado se targetDate for hoje */
  nowDate?: Date;
  /** Margem mínima de antecedência em minutos para agendar no mesmo dia (padrão: 30) */
  minBufferMinutes?: number;
};

/**
 * Calcula os horários livres num determinado dia a partir dos intervalos ocupados
 * (Google Calendar freebusy + appointments do banco).
 *
 * Retorna array de strings de horários livres no fuso de Brasília (ex: ["09:00", "09:30", "14:00"]).
 * Reduz enormemente o consumo de tokens e elimina erros de timezone da IA.
 */
export function calculateFreeSlots(options: FreeSlotsOptions): string[] {
  const {
    targetDate,
    busyRanges = [],
    durationMinutes = 30,
    startHour = 8,
    endHour = 18,
    stepMinutes = 30,
    nowDate = new Date(),
    minBufferMinutes = 30,
  } = options;

  if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    return [];
  }

  const durationMs = Math.max(15, durationMinutes) * 60_000;
  const stepMs = Math.max(15, stepMinutes) * 60_000;
  const nowThresholdMs = nowDate.getTime() + Math.max(0, minBufferMinutes) * 60_000;

  // Limite final do expediente na data (no fuso de Brasília, -03:00)
  const pad = (n: number) => String(n).padStart(2, "0");
  const businessEnd = new Date(`${targetDate}T${pad(endHour)}:00:00-03:00`);
  const businessEndMs = businessEnd.getTime();
  if (isNaN(businessEndMs)) return [];

  const parsedBusy = (busyRanges || [])
    .map((b) => ({
      start: new Date(b.start).getTime(),
      end: new Date(b.end).getTime(),
    }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.start < b.end);

  const freeSlots: string[] = [];

  // Itera minuto a minuto do expediente
  const startDay = new Date(`${targetDate}T${pad(startHour)}:00:00-03:00`);
  let currentStartMs = startDay.getTime();
  if (isNaN(currentStartMs)) return [];

  while (currentStartMs + durationMs <= businessEndMs) {
    const currentEndMs = currentStartMs + durationMs;

    // Se o slot estiver no passado ou muito próximo de agora (no mesmo dia)
    const isPast = currentStartMs < nowThresholdMs;

    if (!isPast) {
      // Checa sobreposição com qualquer intervalo ocupado
      const hasConflict = parsedBusy.some((busy) =>
        rangesOverlap(currentStartMs, currentEndMs, busy.start, busy.end)
      );

      if (!hasConflict) {
        // Converte o currentStartMs para HH:MM em America/Sao_Paulo
        const slotDate = new Date(currentStartMs);
        const timeStr = slotDate.toLocaleTimeString("pt-BR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "America/Sao_Paulo",
          hour12: false,
        });
        freeSlots.push(timeStr);
      }
    }

    currentStartMs += stepMs;
  }

  return freeSlots;
}
