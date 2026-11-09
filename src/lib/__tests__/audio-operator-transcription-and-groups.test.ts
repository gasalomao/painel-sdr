import { describe, it, expect, vi, beforeEach } from "vitest";
import { shouldSkipGroupActions, resolveTranscriptionConfig } from "@/lib/bot-status";

vi.mock("@/lib/supabase_admin", () => {
  return {
    supabaseAdmin: {
      from: vi.fn((table: string) => {
        if (table === "agent_settings") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockImplementation(async () => {
              return {
                data: {
                  id: 1,
                  disable_groups: true,
                  transcription_method: "gemini",
                  options: {
                    transcription_models: ["google/gemini-2.0-flash-exp:free"],
                  },
                },
                error: null,
              };
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
    },
  };
});

describe("Pilar 3: Proteção Estrita de Grupos (disable_groups)", () => {
  it("deve permitir ações e transcrição se não for grupo (@s.whatsapp.net)", async () => {
    const isSkip = await shouldSkipGroupActions("5511999999999@s.whatsapp.net", 1);
    expect(isSkip).toBe(false);
  });

  it("deve bloquear transcrição e IA se for grupo (@g.us) com disable_groups=true", async () => {
    const isSkip = await shouldSkipGroupActions("120363025251234567@g.us", 1);
    expect(isSkip).toBe(true);
  });

  it("deve usar o clientId como fallback para verificar disable_groups se agentId for nulo", async () => {
    const isSkip = await shouldSkipGroupActions("120363025251234567@g.us", null, "client-uuid-123");
    expect(isSkip).toBe(true);
  });
});

describe("Pilar 1 e 2: Resolução de Transcrição e Fallback de Agente", () => {
  it("resolve método e modelos de transcrição configurados para o agente ou cliente", async () => {
    const config = await resolveTranscriptionConfig(1);
    expect(config.method).toBe("gemini");
    expect(config.models).toContain("google/gemini-2.0-flash-exp:free");
  });

  it("resolve método e modelos via clientId se agentId for nulo", async () => {
    const config = await resolveTranscriptionConfig(null, "client-uuid-123");
    expect(config.method).toBe("gemini");
    expect(config.models).toEqual(["google/gemini-2.0-flash-exp:free"]);
  });
});

