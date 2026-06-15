import { describe, it, expect } from "vitest";
import {
  parseAgendaDateTime,
  hasExplicitTimezone,
  isDuplicateSlot,
  hasOtherContactConflict,
  startChanged,
  shouldSendReminder,
  reminderKey,
  rangesOverlap,
  hasAgentOverlapConflict,
} from "../agenda-logic";

/* ============================================================
   TIMEZONE — parseAgendaDateTime (bug do 07h em vez de 10h)
   ============================================================ */
describe("parseAgendaDateTime", () => {
  it("naive (sem fuso) é interpretado como Brasília (-03:00)", () => {
    // 10:00 BRT === 13:00 UTC
    const d = parseAgendaDateTime("2026-06-01T10:00:00");
    expect(d.toISOString()).toBe("2026-06-01T13:00:00.000Z");
  });

  it("respeita offset explícito ±HH:MM", () => {
    const d = parseAgendaDateTime("2026-06-01T10:00:00-03:00");
    expect(d.toISOString()).toBe("2026-06-01T13:00:00.000Z");
  });

  it("respeita Z (UTC) explícito", () => {
    const d = parseAgendaDateTime("2026-06-01T13:00:00Z");
    expect(d.toISOString()).toBe("2026-06-01T13:00:00.000Z");
  });

  it("offset sem dois-pontos (+0000 / -0300)", () => {
    expect(hasExplicitTimezone("2026-06-01T10:00:00-0300")).toBe(true);
    expect(parseAgendaDateTime("2026-06-01T13:00:00-0000").toISOString()).toBe("2026-06-01T13:00:00.000Z");
  });

  it("meia-noite naive vira 03:00 UTC (não pula o dia errado)", () => {
    expect(parseAgendaDateTime("2026-06-01T00:00:00").toISOString()).toBe("2026-06-01T03:00:00.000Z");
  });

  it("string vazia/ inválida → Date inválida (caller trata)", () => {
    expect(isNaN(parseAgendaDateTime("").getTime())).toBe(true);
    expect(isNaN(parseAgendaDateTime("xpto").getTime())).toBe(true);
  });

  it("hasExplicitTimezone detecta corretamente", () => {
    expect(hasExplicitTimezone("2026-06-01T10:00:00")).toBe(false);
    expect(hasExplicitTimezone("2026-06-01T10:00:00Z")).toBe(true);
    expect(hasExplicitTimezone("2026-06-01T10:00:00+05:30")).toBe(true);
  });
});

/* ============================================================
   ANTI-DUPLICAÇÃO — isDuplicateSlot
   ============================================================ */
describe("isDuplicateSlot", () => {
  const start = new Date("2026-06-01T13:00:00Z").getTime();

  it("mesmo horário exato → duplicado", () => {
    expect(isDuplicateSlot([{ start_at: "2026-06-01T13:00:00Z" }], start)).toBe(true);
  });

  it("dentro da tolerância (±2min) → duplicado", () => {
    expect(isDuplicateSlot([{ start_at: "2026-06-01T13:01:30Z" }], start)).toBe(true);
    expect(isDuplicateSlot([{ start_at: "2026-06-01T12:58:30Z" }], start)).toBe(true);
  });

  it("horário diferente (remarcação) → NÃO é duplicado", () => {
    expect(isDuplicateSlot([{ start_at: "2026-06-01T18:30:00Z" }], start)).toBe(false);
    expect(isDuplicateSlot([{ start_at: "2026-06-01T13:05:00Z" }], start)).toBe(false); // 5min fora
  });

  it("lista vazia / null → não é duplicado", () => {
    expect(isDuplicateSlot([], start)).toBe(false);
    expect(isDuplicateSlot(null, start)).toBe(false);
  });

  it("ignora datas inválidas sem quebrar", () => {
    expect(isDuplicateSlot([{ start_at: "lixo" }], start)).toBe(false);
  });
});

/* ============================================================
   CONFLITO DE SLOT (outro contato) — hasOtherContactConflict
   ============================================================ */
describe("hasOtherContactConflict", () => {
  const me = "5511999@s.whatsapp.net";

  it("slot ocupado por OUTRO contato → conflito", () => {
    expect(hasOtherContactConflict([{ remote_jid: "5511888@s.whatsapp.net" }], me)).toBe(true);
  });

  it("slot do PRÓPRIO contato → NÃO é conflito (é duplicação)", () => {
    expect(hasOtherContactConflict([{ remote_jid: me }], me)).toBe(false);
  });

  it("vazio / null → sem conflito", () => {
    expect(hasOtherContactConflict([], me)).toBe(false);
    expect(hasOtherContactConflict(null, me)).toBe(false);
  });

  it("mistura: tem o próprio E outro → conflito", () => {
    expect(hasOtherContactConflict([{ remote_jid: me }, { remote_jid: "5511777@s.whatsapp.net" }], me)).toBe(true);
  });
});

/* ============================================================
   REMARCAÇÃO — startChanged (zera reminders_sent)
   ============================================================ */
describe("startChanged", () => {
  it("horário diferente → true (deve zerar reminders)", () => {
    expect(startChanged("2026-06-01T13:00:00Z", "2026-06-01T18:00:00Z")).toBe(true);
  });
  it("mesmo instante (formatos diferentes) → false", () => {
    expect(startChanged("2026-06-01T13:00:00Z", "2026-06-01T10:00:00-03:00")).toBe(false);
  });
  it("mesmo ISO → false", () => {
    expect(startChanged("2026-06-01T13:00:00.000Z", "2026-06-01T13:00:00.000Z")).toBe(false);
  });
});

/* ============================================================
   LEMBRETE — shouldSendReminder (cancelar/remarcar/offset)
   ============================================================ */
describe("shouldSendReminder", () => {
  const start = new Date("2026-06-01T13:00:00Z").getTime();
  const offset = 30; // 30 min antes → dueAt = 12:30Z

  it("dispara quando passou do horário do lembrete e ainda não começou", () => {
    const now = new Date("2026-06-01T12:45:00Z").getTime(); // entre due (12:30) e start (13:00)
    expect(shouldSendReminder({ status: "confirmed", startMs: start, nowMs: now, offsetMinutes: offset, alreadySent: false })).toBe(true);
  });

  it("NÃO dispara antes da hora do lembrete", () => {
    const now = new Date("2026-06-01T12:00:00Z").getTime(); // antes de due (12:30)
    expect(shouldSendReminder({ status: "confirmed", startMs: start, nowMs: now, offsetMinutes: offset, alreadySent: false })).toBe(false);
  });

  it("NÃO dispara depois que a reunião começou", () => {
    const now = new Date("2026-06-01T13:05:00Z").getTime();
    expect(shouldSendReminder({ status: "confirmed", startMs: start, nowMs: now, offsetMinutes: offset, alreadySent: false })).toBe(false);
  });

  it("CANCELADO nunca dispara (mesmo na janela)", () => {
    const now = new Date("2026-06-01T12:45:00Z").getTime();
    expect(shouldSendReminder({ status: "cancelled", startMs: start, nowMs: now, offsetMinutes: offset, alreadySent: false })).toBe(false);
  });

  it("já enviado → não repete", () => {
    const now = new Date("2026-06-01T12:45:00Z").getTime();
    expect(shouldSendReminder({ status: "confirmed", startMs: start, nowMs: now, offsetMinutes: offset, alreadySent: true })).toBe(false);
  });

  it("offset inválido (0 ou negativo) → não dispara", () => {
    const now = new Date("2026-06-01T12:45:00Z").getTime();
    expect(shouldSendReminder({ status: "confirmed", startMs: start, nowMs: now, offsetMinutes: 0, alreadySent: false })).toBe(false);
    expect(shouldSendReminder({ status: "confirmed", startMs: start, nowMs: now, offsetMinutes: -10, alreadySent: false })).toBe(false);
  });

  it("REMARCAÇÃO: novo horário + reminders_sent zerado → dispara de novo", () => {
    // simula reschedule: start movido pra 18:00Z, reminders_sent foi resetado
    const newStart = new Date("2026-06-01T18:00:00Z").getTime();
    const now = new Date("2026-06-01T17:45:00Z").getTime();
    expect(shouldSendReminder({ status: "confirmed", startMs: newStart, nowMs: now, offsetMinutes: offset, alreadySent: false })).toBe(true);
  });

  it("status completed/no_show não dispara", () => {
    const now = new Date("2026-06-01T12:45:00Z").getTime();
    expect(shouldSendReminder({ status: "completed", startMs: start, nowMs: now, offsetMinutes: offset, alreadySent: false })).toBe(false);
    expect(shouldSendReminder({ status: "no_show", startMs: start, nowMs: now, offsetMinutes: offset, alreadySent: false })).toBe(false);
  });
});

describe("reminderKey", () => {
  it("formata offset → chave", () => {
    expect(reminderKey(30)).toBe("30min");
    expect(reminderKey(1440)).toBe("1440min");
  });
});

/* ============================================================
   DISPONIBILIDADE / SOBREPOSIÇÃO — rangesOverlap + hasAgentOverlapConflict
   ============================================================ */
describe("rangesOverlap", () => {
  it("sobreposição parcial → true", () => {
    // 10:00-10:30 vs 10:15-10:45
    expect(rangesOverlap(0, 30, 15, 45)).toBe(true);
  });
  it("encostado (fim == início) → false (meia-aberto)", () => {
    // 10:00-10:30 e 10:30-11:00 NÃO conflitam
    expect(rangesOverlap(0, 30, 30, 60)).toBe(false);
  });
  it("um dentro do outro → true", () => {
    expect(rangesOverlap(10, 20, 0, 60)).toBe(true);
  });
  it("totalmente separados → false", () => {
    expect(rangesOverlap(0, 30, 60, 90)).toBe(false);
  });
});

describe("hasAgentOverlapConflict (remarcação sem conflito)", () => {
  const me = "5511999@s.whatsapp.net";
  const other = "5511888@s.whatsapp.net";
  // novo intervalo: 14:00-14:30 BRT = 17:00-17:30 UTC
  const nStart = new Date("2026-06-01T17:00:00Z").getTime();
  const nEnd = new Date("2026-06-01T17:30:00Z").getTime();

  it("outro contato sobrepondo parcialmente → conflito", () => {
    const rows = [{ remote_jid: other, start_at: "2026-06-01T17:15:00Z", end_at: "2026-06-01T17:45:00Z" }];
    expect(hasAgentOverlapConflict(rows, nStart, nEnd, me)).toBe(true);
  });

  it("horário totalmente livre → sem conflito", () => {
    const rows = [{ remote_jid: other, start_at: "2026-06-01T19:00:00Z", end_at: "2026-06-01T19:30:00Z" }];
    expect(hasAgentOverlapConflict(rows, nStart, nEnd, me)).toBe(false);
  });

  it("agendamento encostado (fim == início) → sem conflito", () => {
    const rows = [{ remote_jid: other, start_at: "2026-06-01T17:30:00Z", end_at: "2026-06-01T18:00:00Z" }];
    expect(hasAgentOverlapConflict(rows, nStart, nEnd, me)).toBe(false);
  });

  it("o PRÓPRIO contato no mesmo intervalo → NÃO conflita (remarcar consigo)", () => {
    const rows = [{ remote_jid: me, start_at: "2026-06-01T17:00:00Z", end_at: "2026-06-01T17:30:00Z" }];
    expect(hasAgentOverlapConflict(rows, nStart, nEnd, me)).toBe(false);
  });

  it("lista vazia / null → sem conflito", () => {
    expect(hasAgentOverlapConflict([], nStart, nEnd, me)).toBe(false);
    expect(hasAgentOverlapConflict(null, nStart, nEnd, me)).toBe(false);
  });

  it("datas inválidas são ignoradas", () => {
    expect(hasAgentOverlapConflict([{ remote_jid: other, start_at: "x", end_at: "y" }], nStart, nEnd, me)).toBe(false);
  });
});
