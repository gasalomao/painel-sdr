import { describe, it, expect } from "vitest";
import {
  buildKanbanAppendix,
  buildDateContext,
  buildOrganizerSystemPrompt,
  DEFAULT_ORGANIZER_BASE_PROMPT,
  type KanbanColLite,
} from "../organizer-prompt";

const COLS: KanbanColLite[] = [
  { status_key: "primeiro_contato", label: "Primeiro contato", order_index: 0 },
  { status_key: "interessado", label: "Interessado", order_index: 1 },
  { status_key: "agendado", label: "Agendado", order_index: 2 },
  { status_key: "fechado", label: "Fechado", order_index: 3 },
  { status_key: "sem_interesse", label: "Sem interesse", order_index: 4 },
  { status_key: "perdido", label: "Perdido", order_index: 5 },
];

describe("buildKanbanAppendix", () => {
  it("retorna vazio se não há colunas", () => {
    const out = buildKanbanAppendix([]);
    expect(out.kanbanAppendix).toBe("");
    expect(out.terminalKeys).toEqual([]);
  });

  it("detecta terminais por regex (sem_interesse / perdido / descartado / cancelado / recusou)", () => {
    const out = buildKanbanAppendix(COLS);
    expect(out.terminalKeys).toContain("sem_interesse");
    expect(out.terminalKeys).toContain("perdido");
    expect(out.terminalKeys).not.toContain("primeiro_contato");
    expect(out.terminalKeys).not.toContain("fechado");
  });

  it("inclui todos os status_key no apêndice em ordem", () => {
    const out = buildKanbanAppendix(COLS);
    const idxPrimeiro = out.kanbanAppendix.indexOf("primeiro_contato");
    const idxFechado = out.kanbanAppendix.indexOf("fechado");
    expect(idxPrimeiro).toBeGreaterThan(-1);
    expect(idxFechado).toBeGreaterThan(idxPrimeiro);
  });

  it("kanban sem terminais negativos retorna mensagem específica", () => {
    const cols: KanbanColLite[] = [
      { status_key: "novo", label: "Novo", order_index: 0 },
      { status_key: "ativo", label: "Ativo", order_index: 1 },
    ];
    const out = buildKanbanAppendix(cols);
    expect(out.terminalKeys).toEqual([]);
    expect(out.kanbanAppendix).toContain("nenhum");
  });

  it("regex de terminal é case-insensitive", () => {
    const cols: KanbanColLite[] = [
      { status_key: "DESCARTADO", label: "X", order_index: 0 },
    ];
    expect(buildKanbanAppendix(cols).terminalKeys).toContain("DESCARTADO");
  });
});

describe("buildDateContext", () => {
  it("inclui DATA DE HOJE com ISO", () => {
    const fixed = new Date("2026-05-17T10:00:00Z");
    const ctx = buildDateContext(fixed);
    expect(ctx).toContain("2026-05-17");
    expect(ctx).toContain("DATA DE HOJE");
  });

  it("formata data em pt-BR", () => {
    const fixed = new Date("2026-05-17T10:00:00Z");
    const ctx = buildDateContext(fixed);
    expect(ctx).toMatch(/2026/);
  });
});

describe("buildOrganizerSystemPrompt", () => {
  it("usa custom prompt quando passado", () => {
    const { systemPrompt } = buildOrganizerSystemPrompt("CUSTOM XYZ", COLS, new Date("2026-05-17"));
    expect(systemPrompt).toContain("CUSTOM XYZ");
    expect(systemPrompt).not.toContain("classificador SÊNIOR de leads");
  });

  it("usa default quando customPrompt é null ou whitespace", () => {
    const a = buildOrganizerSystemPrompt(null, COLS, new Date("2026-05-17"));
    const b = buildOrganizerSystemPrompt("   ", COLS, new Date("2026-05-17"));
    expect(a.systemPrompt).toContain("classificador SÊNIOR");
    expect(b.systemPrompt).toContain("classificador SÊNIOR");
  });

  it("retorna systemPrompt = base + kanban + data + appointments", () => {
    const out = buildOrganizerSystemPrompt(null, COLS, new Date("2026-05-17"));
    expect(out.systemPrompt).toBe(out.defaultBasePrompt + out.kanbanAppendix + out.dateContext + out.appointmentsContext);
  });

  it("appointmentsContext vazio quando não há agendamentos", () => {
    const out = buildOrganizerSystemPrompt(null, COLS, new Date("2026-05-17"), []);
    expect(out.appointmentsContext).toContain("Nenhum agendamento");
  });

  it("appointmentsContext lista agendamentos com FUTURO/PASSADO/EM CURSO", () => {
    const fixed = new Date("2026-05-18T12:00:00Z");
    const out = buildOrganizerSystemPrompt(null, COLS, fixed, [
      { start_at: "2026-05-20T14:00:00Z", end_at: "2026-05-20T15:00:00Z", status: "confirmed", title: "Corte", service_name: "Corte" },
      { start_at: "2026-05-10T10:00:00Z", end_at: "2026-05-10T11:00:00Z", status: "completed", title: "Manicure", service_name: "Manicure" },
    ]);
    expect(out.appointmentsContext).toContain("FUTURO");
    expect(out.appointmentsContext).toContain("PASSADO");
    expect(out.appointmentsContext).toContain("Corte");
    expect(out.appointmentsContext).toContain("Manicure");
  });

  it("expõe terminalKeys consistentes com buildKanbanAppendix", () => {
    const out = buildOrganizerSystemPrompt(null, COLS, new Date());
    expect(out.terminalKeys).toContain("sem_interesse");
  });

  it("base default contém regras R1-R17", () => {
    expect(DEFAULT_ORGANIZER_BASE_PROMPT).toContain("R1.");
    expect(DEFAULT_ORGANIZER_BASE_PROMPT).toContain("R17.");
    expect(DEFAULT_ORGANIZER_BASE_PROMPT).toContain("R15");
  });
});
