import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { extractWhatsAppConversationContext } from "../whatsapp-context-extractor";
import { provisionLeadWorkspace } from "../workspace-provisioner";
import { buildAutonomousSitePrompt } from "../opencode-runner";
import { sanitizeVercelProjectName } from "../vercel-deployer";

describe("Autonomous Prospecting & Site Generation Pipeline", () => {
  describe("WhatsApp Context Extractor", () => {
    it("extrai links de agendamento e regras de PIX da conversa", async () => {
      const mockSupabase: any = {
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue({
                    data: [
                      { sender_type: "client", content: "Olá, atendemos apenas com hora marcada." },
                      { sender_type: "client", content: "Nosso link para agendar é https://tuaagenda.com/salao-luz" },
                      { sender_type: "client", content: "Exigimos sinal de 50% via chave pix telefone para confirmar o horário." },
                    ],
                  }),
                })),
              })),
            })),
          })),
        })),
      };

      const result = await extractWhatsAppConversationContext("5511999999999@s.whatsapp.net", "tenant-1", mockSupabase);

      expect(result.linksAgendamento).toContain("https://tuaagenda.com/salao-luz");
      expect(result.regrasPix.length).toBeGreaterThan(0);
      expect(result.restricoesAtendimento.length).toBeGreaterThan(0);
      expect(result.mensagensIntegraisCliente.length).toBe(3);
      expect(result.rawSummary).toContain("https://tuaagenda.com/salao-luz");
      expect(result.rawSummary).toContain("MENSAGENS REAIS ENVIADAS PELO CLIENTE");
    });
  });

  describe("Workspace Provisioner", () => {
    it("monta workspace temporário com INFORMACOES-DO-NEGOCIO.txt e pasta de fotos", async () => {
      const tempDir = path.join(os.tmpdir(), `test-ws-${Date.now()}`);

      const lead = {
        id: 9999,
        nome_negocio: "Clínica Bem Estar",
        ramo_negocio: "Estética e Saúde",
        telefone: "11988887777",
        endereco: "Av Paulista 1000",
        client_id: "tenant-1",
        remoteJid: "5511988887777@s.whatsapp.net",
      };

      const ws = await provisionLeadWorkspace({
        lead,
        maxPhotos: 5,
        customWorkspaceDir: tempDir,
        supabaseClient: {
          from: () => ({
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => Promise.resolve({ data: [] }),
                  }),
                }),
              }),
            }),
          }),
        },
      });

      expect(ws.workspaceDir).toBe(tempDir);
      expect(ws.txtPath).toBe(path.join(tempDir, "INFORMACOES-DO-NEGOCIO.txt"));

      const content = await fs.readFile(ws.txtPath, "utf-8");
      expect(content).toContain("CLÍNICA BEM ESTAR");
      expect(content).toContain("Estética e Saúde");

      // Limpeza
      await fs.rm(tempDir, { recursive: true, force: true });
    }, 15_000);
  });

  describe("OpenCode Runner Prompt", () => {
    it("constrói prompt com Impeccable e referências ao briefing", () => {
      const prompt = buildAutonomousSitePrompt({
        leadName: "Barbearia Vintage",
        niche: "Barbearia",
      });

      expect(prompt).toContain("impeccable");
      expect(prompt).toContain("INFORMACOES-DO-NEGOCIO.txt");
      expect(prompt).toContain("./fotos/");
      expect(prompt).toContain("Barbearia Vintage");
    });
  });

  describe("Vercel Deployer", () => {
    it("higieniza o nome do projeto para o padrão exigido pela Vercel", () => {
      const safe = sanitizeVercelProjectName("Clínica Estética & Bronzeamento São Paulo!!!");
      expect(safe).toBe("clinica-estetica-bronzeamento-sao-paulo");
      expect(safe).not.toContain(" ");
      expect(safe).not.toContain("&");
    });
  });
});
