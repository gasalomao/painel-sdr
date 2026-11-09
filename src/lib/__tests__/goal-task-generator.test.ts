import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  calculateDueAt,
  normalizeGoalTaskConfig,
  cleanGeneratedTaskText,
  DEFAULT_GOAL_TASK_CONFIG,
  DEFAULT_GOAL_TASK_PROMPT,
  triggerGoalTaskGeneration,
} from "../goal-task-generator";

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: vi.fn(),
  },
}));

vi.mock("@/lib/ai-provider", () => ({
  generateText: vi.fn(),
}));

describe("goal-task-generator", () => {
  describe("calculateDueAt", () => {
    it("adiciona horas com precisão", () => {
      const base = new Date("2026-11-06T10:00:00.000Z"); // Sexta-feira
      const due = calculateDueAt(5, "hours", base);
      expect(due.toISOString()).toBe("2026-11-06T15:00:00.000Z");
    });

    it("adiciona dias corridos incluindo fim de semana", () => {
      const base = new Date("2026-11-06T10:00:00.000Z"); // Sexta-feira
      const due = calculateDueAt(2, "days", base);
      // Sexta + 2 dias corridos = Domingo
      expect(due.toISOString()).toBe("2026-11-08T10:00:00.000Z");
    });

    it("adiciona dias úteis pulando sábado e domingo", () => {
      const base = new Date("2026-11-06T14:30:00.000Z"); // Sexta-feira
      const due = calculateDueAt(2, "business_days", base);
      // Sexta -> pula Sábado e Domingo -> Segunda (+1), Terça (+2)
      expect(due.toISOString()).toBe("2026-11-10T14:30:00.000Z");
      expect(due.getUTCDay()).toBe(2); // 2 = Terça-feira
    });

    it("avança múltiplos fins de semana em prazos maiores de dias úteis", () => {
      const base = new Date("2026-11-02T09:00:00.000Z"); // Segunda-feira
      const due = calculateDueAt(10, "business_days", base);
      // 10 dias úteis = 2 semanas inteiras -> Segunda 16 de Novembro
      expect(due.toISOString()).toBe("2026-11-16T09:00:00.000Z");
      expect(due.getUTCDay()).toBe(1); // Segunda-feira
    });

    it("quando o baseDate é sábado ou domingo, avança para os próximos dias úteis", () => {
      const base = new Date("2026-11-07T10:00:00.000Z"); // Sábado
      const due = calculateDueAt(1, "business_days", base);
      // Pula Domingo -> Segunda
      expect(due.toISOString()).toBe("2026-11-09T10:00:00.000Z");
      expect(due.getUTCDay()).toBe(1);
    });
  });

  describe("normalizeGoalTaskConfig", () => {
    it("retorna defaults quando recebe nulo ou inválido", () => {
      expect(normalizeGoalTaskConfig(null)).toEqual(DEFAULT_GOAL_TASK_CONFIG);
      expect(normalizeGoalTaskConfig({})).toEqual(DEFAULT_GOAL_TASK_CONFIG);
      expect(normalizeGoalTaskConfig("invalido")).toEqual(DEFAULT_GOAL_TASK_CONFIG);
    });

    it("normaliza valores personalizados e aplica limites seguros", () => {
      const cfg = normalizeGoalTaskConfig({
        enabled: true,
        deadline_value: 5,
        deadline_unit: "days",
        model: "openrouter:google/gemini-2.5-flash",
        prompt: "Minha instrução customizada",
      });

      expect(cfg.enabled).toBe(true);
      expect(cfg.deadline_value).toBe(5);
      expect(cfg.deadline_unit).toBe("days");
      expect(cfg.model).toBe("openrouter:google/gemini-2.5-flash");
      expect(cfg.prompt).toBe("Minha instrução customizada");
    });

    it("recupera unidade padrão caso valor de unidade seja desconhecido", () => {
      const cfg = normalizeGoalTaskConfig({
        deadline_unit: "meses_invalidos",
        deadline_value: -10,
      });
      expect(cfg.deadline_unit).toBe("business_days");
      expect(cfg.deadline_value).toBe(2);
    });
  });

  describe("cleanGeneratedTaskText", () => {
    it("remove aspas e prefixos de tarefa", () => {
      expect(cleanGeneratedTaskText('"Tarefa: Entregar prévia do site da Pizzaria"')).toBe(
        "Entregar prévia do site da Pizzaria"
      );
      expect(cleanGeneratedTaskText("Ação: Agendar call com Dr. Carlos")).toBe(
        "Agendar call com Dr. Carlos"
      );
    });

    it("remove negrito Markdown e normaliza quebras de linha", () => {
      expect(cleanGeneratedTaskText("**Entregar site**\npara Clínica Sorriso")).toBe(
        "Entregar site - para Clínica Sorriso"
      );
    });

    it("usa fallback amigável quando o texto é vazio", () => {
      expect(cleanGeneratedTaskText("", "Advocacia Lima")).toBe(
        "Dar andamento à proposta/prévia para Advocacia Lima"
      );
    });
  });

  describe("triggerGoalTaskGeneration", () => {
    let mockSupabase: any;
    let mockGenerateText: any;

    beforeEach(async () => {
      vi.clearAllMocks();
      const { supabaseAdmin } = await import("@/lib/supabase_admin");
      const { generateText } = await import("@/lib/ai-provider");
      mockSupabase = supabaseAdmin;
      mockGenerateText = generateText;
    });

    it("ignora geração se o gatilho estiver desabilitado", async () => {
      mockSupabase.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                features: {
                  goal_task_trigger: { enabled: false },
                },
              },
              error: null,
            }),
          }),
        }),
      });

      const res = await triggerGoalTaskGeneration({
        clientId: "client-123",
        remoteJid: "5511999999999@s.whatsapp.net",
        goalText: "Aceitar prévia de site",
      });

      expect(res.created).toBe(false);
      expect(res.reason).toBe("disabled");
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it("gera tarefa quando o gatilho está ativado e insere no dashboard_tasks", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "Entregar prévia do site institucional para Restaurante Sabor",
      });

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "clients") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    features: {
                      goal_task_trigger: {
                        enabled: true,
                        deadline_value: 2,
                        deadline_unit: "business_days",
                        model: "gemini:gemini-2.5-flash",
                        prompt: "Crie a tarefa",
                      },
                    },
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "leads_extraidos") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 456, nome_negocio: "Restaurante Sabor" },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "dashboard_tasks") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  is: vi.fn().mockReturnValue({
                    gte: vi.fn().mockReturnValue({
                      limit: vi.fn().mockResolvedValue({
                        data: [], // sem tarefas duplicadas
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            }),
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: "task-uuid-1",
                    text: "Entregar prévia do site institucional para Restaurante Sabor",
                    due_at: "2026-11-10T14:00:00.000Z",
                    lead_id: 456,
                    created_at: "2026-11-08T14:00:00.000Z",
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "webhook_logs") {
          return {
            insert: vi.fn().mockReturnValue(Promise.resolve()),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
        };
      });

      const res = await triggerGoalTaskGeneration({
        clientId: "client-123",
        leadId: 456,
        remoteJid: "5511999999999@s.whatsapp.net",
        goalText: "Fazer cliente aceitar fazer a prévia do site",
        businessName: "Restaurante Sabor",
        baseDate: new Date("2026-11-06T14:00:00.000Z"), // Sexta-feira
      });

      expect(res.created).toBe(true);
      expect(res.taskId).toBe("task-uuid-1");
      expect(res.leadId).toBe(456);
      expect(res.text).toBe("Entregar prévia do site institucional para Restaurante Sabor");
      // 2 dias úteis de Sexta às 14:00 é Terça às 14:00
      expect(res.dueAt).toBe("2026-11-10T14:00:00.000Z");
      expect(mockGenerateText).toHaveBeenCalled();
    });

    it("evita tarefas duplicadas caso uma tarefa recente ainda esteja pendente para o mesmo lead", async () => {
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "clients") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    features: {
                      goal_task_trigger: { enabled: true },
                    },
                  },
                }),
              }),
            }),
          };
        }
        if (table === "dashboard_tasks") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  is: vi.fn().mockReturnValue({
                    gte: vi.fn().mockReturnValue({
                      limit: vi.fn().mockResolvedValue({
                        data: [{ id: "existing-task-id" }], // já existe tarefa recente!
                      }),
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        return { select: vi.fn().mockReturnThis() };
      });

      const res = await triggerGoalTaskGeneration({
        clientId: "client-123",
        leadId: 789,
        remoteJid: "5511999999999@s.whatsapp.net",
        goalText: "Aceitar prévia de site",
      });

      expect(res.created).toBe(false);
      expect(res.reason).toBe("duplicate_recent_task");
      expect(mockGenerateText).not.toHaveBeenCalled();
    });
  });
});

