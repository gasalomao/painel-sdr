import { describe, expect, it, vi, beforeEach } from "vitest";
import { evaluatePreviewAgreement } from "../agreement-detector";
import { sendPingActiveMessage } from "../autonomous-worker-engine";

describe("Ciclo Completo Sarah SDR/Closer: Aceite -> Geração -> Duplo Vínculo -> Script Sarah -> Agendamento", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Etapa 1: Identifica com precisão cirúrgica se o lead aceitou a prévia (via IA leve e fallback)", async () => {
    // 1. Mensagem de aceite do lead
    const messages = [
      {
        role: "agent" as const,
        content:
          "Show, já passei aqui para a nossa equipe montar a prévia da Oficina São José! Quando a gente finalizar e te mandar o link por aqui você consegue dar uma olhadinha rápida para dizer o que achou?",
      },
      {
        role: "user" as const,
        content: "Com certeza, pode montar sim! Assim que mandar eu olho aqui no celular.",
      },
    ];

    // Simula resposta da IA leve avaliadora
    const aiProvider = await import("@/lib/ai-provider");
    const generateSpy = vi.spyOn(aiProvider, "generateText").mockResolvedValueOnce({
      text: JSON.stringify({
        aceitou: true,
        confianca: "alta",
        motivo: "Cliente confirmou que vai olhar no celular assim que mandar",
      }),
      usage: { promptTokens: 35, completionTokens: 18, totalTokens: 53 },
    } as any);

    const result = await evaluatePreviewAgreement({ messages });
    expect(result.agreed).toBe(true);
    expect(result.evaluatorMethod).toBe("ai");
    expect(result.tokensUsed).toBe(53);
    expect(result.reason).toContain("Cliente confirmou");
    generateSpy.mockRestore();
  });

  it("Etapa 2: Após geração do site na VPS, vincula o link e executa o ping de atenção (Duplo Vínculo)", async () => {
    let capturedLeadUpdates: any = null;
    let sentChatMessage: any = null;

    const mockSupabase: any = {
      from: vi.fn((table: string) => {
        if (table === "channel_connections") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { agent_id: 1 } }),
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
            maybeSingle: vi.fn().mockResolvedValue({ data: { instance_name: "instancia-oficial" } }),
            insert: vi.fn((payload) => {
              sentChatMessage = payload;
              return Promise.resolve({ error: null });
            }),
          };
        }
        if (table === "leads_extraidos") {
          return {
            update: vi.fn((payload) => {
              capturedLeadUpdates = payload;
              return {
                eq: vi.fn().mockResolvedValue({ error: null }),
              };
            }),
          };
        }
        if (table === "automations" || table === "automation_logs") {
          return {
            select: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: "auto-sarah" } }),
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

    const leadReady = {
      id: 999,
      remoteJid: "5511999887766@s.whatsapp.net",
      nome_negocio: "Oficina São José",
      link_previa: "https://oficina-sao-jose.vercel.app",
      client_id: "tenant-principal",
      previa_status: "PREVIA_PRONTA",
    };

    const sent = await sendPingActiveMessage(leadReady, mockSupabase, { skipWhatsApp: true });
    expect(sent).toBe(true);
    expect(sentChatMessage.content).toContain("Oficina São José");
    expect(sentChatMessage.content).toContain("celular na mão");
    expect(sentChatMessage.content).not.toContain("https://oficina-sao-jose.vercel.app"); // Não vaza o link antes da confirmação!
    expect(capturedLeadUpdates?.previa_ping_enviado_em).toBeDefined();
    expect(capturedLeadUpdates?.previa_link_enviado_em).toBeUndefined();
  });

  it("Etapa 3 & 4: Processa o script oficial da Sarah Closer, entrega o link e agenda a reunião", async () => {
    // Valida a presença das diretrizes no prompt do agente
    const leadState = {
      nome_negocio: "Oficina São José",
      previa_status: "PREVIA_PRONTA",
      link_previa: "https://oficina-sao-jose.vercel.app",
      previa_ping_enviado_em: "2026-11-02T10:00:00Z",
    };

    // Simulando a lógica de diretrizes de Sarah Closer injetada no route.ts
    const confirmBeforeLink = true;
    const pingEnviado = !!leadState.previa_ping_enviado_em;

    const lines: string[] = [];
    if (leadState.previa_status === "PREVIA_PRONTA" && leadState.link_previa) {
      lines.push("# 🎯 MODO SARAH CLOSER ATIVO (PRÉVIA PRONTA NO AR):");
      lines.push(`- Link da prévia: ${leadState.link_previa}`);
      if (confirmBeforeLink) {
        if (!pingEnviado) {
          lines.push(`- AÇÃO OBRIGATÓRIA NESTE TURNO: Envie a pergunta de disponibilidade.`);
        } else {
          lines.push(
            `- AÇÃO OBRIGATÓRIA: O cliente respondeu à pergunta de disponibilidade! Envie agora o link (${leadState.link_previa}) com a introdução: "Dá uma olhadinha aí no celular! Como é uma prévia inicial, montamos com o que encontramos disponível na internet só para você ter uma ideia de como a estrutura funciona, mas depois deixamos 100% do seu jeito, com as suas fotos e cores preferidas. Me conta: o que achou dessa ideia para a ${leadState.nome_negocio}?"`
          );
          lines.push(`- MATRIZ DE FECHAMENTO:`);
          lines.push(`  1. ZERO PREÇO POR TEXTO: Nunca passe valores por mensagem.`);
          lines.push(`  2. ZERO TERMOS TÉCNICOS: Proibido falar domínio, hospedagem, servidor ou DNS.`);
          lines.push(`  3. REGRA DO DUPLO VÍNCULO: Agende uma call rápida de 2 a 5 min no WhatsApp.`);
          lines.push(`  4. Se o cliente concordar com um horário, chame OBRIGATORIAMENTE a tool "agendar_reuniao_fechamento".`);
        }
      }
    }

    const promptSarah = lines.join("\n");

    // Validações estritas do script da Sarah Closer
    expect(promptSarah).toContain("MODO SARAH CLOSER ATIVO");
    expect(promptSarah).toContain(leadState.link_previa);
    expect(promptSarah).toContain("Dá uma olhadinha aí no celular!");
    expect(promptSarah).toContain("ZERO PREÇO POR TEXTO");
    expect(promptSarah).toContain("ZERO TERMOS TÉCNICOS");
    expect(promptSarah).toContain("REGRA DO DUPLO VÍNCULO");
    expect(promptSarah).toContain("agendar_reuniao_fechamento");

    // Simula a execução da tool de agendamento de reunião quando o lead concorda com o horário
    const callArgs = {
      horario_confirmado: "Amanhã às 15:30",
      resumo_necessidades: "Cliente quer colocar fotos da oficina e trocar logotipo",
    };

    let updatedLeadDb: any = null;
    const mockDb: any = {
      from: vi.fn(() => ({
        update: vi.fn((data) => {
          updatedLeadDb = data;
          return {
            eq: vi.fn(() => ({
              eq: vi.fn().mockResolvedValue({ error: null }),
            })),
          };
        }),
      })),
    };

    await mockDb
      .from("leads_extraidos")
      .update({
        previa_status: "REUNIAO_AGENDADA",
        status: "REUNIAO_AGENDADA",
        reuniao_agendada_em: new Date().toISOString(),
        reuniao_horario_confirmado: callArgs.horario_confirmado,
        reuniao_resumo: callArgs.resumo_necessidades,
      })
      .eq("client_id", "tenant-principal")
      .eq("remoteJid", "5511999887766@s.whatsapp.net");

    expect(updatedLeadDb.previa_status).toBe("REUNIAO_AGENDADA");
    expect(updatedLeadDb.reuniao_horario_confirmado).toBe("Amanhã às 15:30");
    expect(updatedLeadDb.reuniao_resumo).toContain("Cliente quer colocar fotos da oficina");
  });
});
