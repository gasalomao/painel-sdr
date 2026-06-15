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
