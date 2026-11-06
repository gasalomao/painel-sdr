import { describe, expect, it, vi, beforeEach } from "vitest";
import { sendPingActiveMessage } from "../autonomous-worker-engine";

describe("Fluxo de Envio e Duplo Vínculo da Prévia (Worker)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("envia ping perguntando se está com o celular na mão quando duplo vínculo está ativo", async () => {
    const mockSupabase: any = {
      from: vi.fn((table: string) => {
        if (table === "channel_connections") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { agent_id: 10 } }),
          };
        }
        if (table === "agent_settings") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                options: {
                  site_preview_confirm_before_link: true,
                  site_preview_ping_message: "Oi! A prévia da {{nome_negocio}} tá no ar. Pode olhar agora?",
                },
              },
            }),
          };
        }
        if (table === "chats_dashboard") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            not: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { instance_name: "instancia-teste" } }),
            insert: vi.fn().mockResolvedValue({ error: null }),
          };
        }
        if (table === "leads_extraidos") {
          return {
            update: vi.fn((payload) => ({
              eq: vi.fn(() => {
                expect(payload.previa_ping_enviado_em).toBeDefined();
                expect(payload.previa_link_enviado_em).toBeUndefined();
                return Promise.resolve({ error: null });
              }),
            })),
          };
        }
        if (table === "automations" || table === "automation_logs") {
          return {
            select: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: "auto-1" } }),
            insert: vi.fn().mockResolvedValue({ error: null }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        };
      }),
    };

    const lead = {
      id: 123,
      remoteJid: "5511999999999@s.whatsapp.net",
      nome_negocio: "Oficina do João",
      link_previa: "https://oficina-joao.vercel.app",
      client_id: "client-test",
    };

    const success = await sendPingActiveMessage(lead, mockSupabase, { skipWhatsApp: true });
    expect(success).toBe(true);

    const chatInsertCall = mockSupabase.from.mock.calls.find((call: any[]) => call[0] === "chats_dashboard");
    expect(chatInsertCall).toBeDefined();
  });

  it("envia o link diretamente sem ping quando o duplo vínculo é desativado", async () => {
    let capturedUpdates: any = null;

    const mockSupabase: any = {
      from: vi.fn((table: string) => {
        if (table === "channel_connections") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { agent_id: 20 } }),
          };
        }
        if (table === "agent_settings") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                options: {
                  site_preview_confirm_before_link: false,
                },
              },
            }),
          };
        }
        if (table === "chats_dashboard") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            not: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { instance_name: "instancia-teste-2" } }),
            insert: vi.fn((payload) => {
              expect(payload.content).toContain("https://clinica-vitta.vercel.app");
              return Promise.resolve({ error: null });
            }),
          };
        }
        if (table === "leads_extraidos") {
          return {
            update: vi.fn((payload) => ({
              eq: vi.fn(() => {
                capturedUpdates = payload;
                return Promise.resolve({ error: null });
              }),
            })),
          };
        }
        if (table === "automations" || table === "automation_logs") {
          return {
            select: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: "auto-2" } }),
            insert: vi.fn().mockResolvedValue({ error: null }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        };
      }),
    };

    const lead = {
      id: 456,
      remoteJid: "5511888888888@s.whatsapp.net",
      nome_negocio: "Clínica Vitta",
      link_previa: "https://clinica-vitta.vercel.app",
      client_id: "client-test",
    };

    const success = await sendPingActiveMessage(lead, mockSupabase, { skipWhatsApp: true });
    expect(success).toBe(true);
    expect(capturedUpdates?.previa_ping_enviado_em).toBeDefined();
    expect(capturedUpdates?.previa_link_enviado_em).toBeDefined();
  });
});
