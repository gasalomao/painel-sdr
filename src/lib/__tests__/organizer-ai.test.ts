import { describe, it, expect } from "vitest";
import {
  extractJsonSafe,
  inferColumnSemanticGuide,
  isTerminalColumn,
  buildOrganizerSystemPrompt,
  buildAgentContextAppendix,
} from "../organizer-prompt";
import { normalizeOrganizerAiOutput } from "@/app/api/ai-organize/route";

describe("Organizador IA — Resiliência JSON, Auto-Adaptação de Colunas e Agente", () => {
  describe("extractJsonSafe", () => {
    it("extrai JSON limpo mesmo quando o modelo inclui bloco <think> e markdown ```json", () => {
      const raw = `<think>
Vou analisar a conversa da clínica odontológica e decidir a coluna.
</think>
\`\`\`json
[
  {
    "jid": "553198333558@s.whatsapp.net",
    "status": "previa_solicitada",
    "lead_type": "quente",
    "razao": "Cliente aceitou receber a prévia gratuita",
    "resumo": "Cliente respondeu Sim para ver a prévia."
  }
]
\`\`\``;
      const parsed = extractJsonSafe<any[]>(raw);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].jid).toBe("553198333558@s.whatsapp.net");
      expect(parsed[0].status).toBe("previa_solicitada");
    });

    it("repara quebras de linha literais dentro de strings JSON e vírgulas sobrando", () => {
      const rawWithNewlines = `{
  "rationale": "Funil pensado para o nicho de estética
com qualificação rápida e envio de prévia.",
  "columns": [
    { "status_key": "novo", "label": "Novos Leads", "color": "slate", "is_terminal": false, },
  ],
}`;
      const parsed = extractJsonSafe<{ rationale: string; columns: any[] }>(rawWithNewlines);
      expect(parsed.rationale).toContain("Funil pensado para o nicho de estética");
      expect(parsed.columns).toHaveLength(1);
      expect(parsed.columns[0].status_key).toBe("novo");
    });
  });

  describe("normalizeOrganizerAiOutput", () => {
    it("normaliza array direto, objeto wrapper (results/leads) e mapa legado", () => {
      const direct = normalizeOrganizerAiOutput([
        { jid: "5511999999999@s.whatsapp.net", status: "em_qualificacao", razao: "Respondeu", resumo: "Em conversa" },
      ]);
      expect(direct).toHaveLength(1);
      expect(direct[0].status).toBe("em_qualificacao");

      const wrapped = normalizeOrganizerAiOutput({
        results: [
          { remote_jid: "5511888888888@s.whatsapp.net", status_novo: "em_negociacao", justificativa: "Link enviado" },
        ],
      });
      expect(wrapped).toHaveLength(1);
      expect(wrapped[0].jid).toBe("5511888888888@s.whatsapp.net");
      expect(wrapped[0].status).toBe("em_negociacao");
      expect(wrapped[0].razao).toBe("Link enviado");

      const legacyMap = normalizeOrganizerAiOutput({
        "5511777777777@s.whatsapp.net": "sem_interesse",
      });
      expect(legacyMap).toHaveLength(1);
      expect(legacyMap[0].jid).toBe("5511777777777@s.whatsapp.net");
      expect(legacyMap[0].status).toBe("sem_interesse");
    });
  });

  describe("inferColumnSemanticGuide & isTerminalColumn", () => {
    it("infere corretamente a semântica das 10 colunas do funil da Sarah SDR e colunas de qualquer nicho", () => {
      expect(inferColumnSemanticGuide({ status_key: "primeiro_contato", label: "1º Contato" })).toContain(
        "ainda não respondeu"
      );
      expect(inferColumnSemanticGuide({ status_key: "em_qualificacao", label: "Em Qualificação" })).toContain(
        "conversa/diagnóstico"
      );
      expect(inferColumnSemanticGuide({ status_key: "previa_solicitada", label: "Prévia Solicitada" })).toContain(
        "ACEITOU"
      );
      expect(inferColumnSemanticGuide({ status_key: "em_negociacao", label: "Prévia Enviada / Negociação" })).toContain(
        "já foi enviado"
      );
      expect(inferColumnSemanticGuide({ status_key: "agendado", label: "Reunião / Call Agendada" })).toContain(
        "horário combinado"
      );
    });

    it("detecta colunas terminais via flag explícita ou heurística de nome", () => {
      expect(isTerminalColumn({ status_key: "fechado", label: "Fechado (Ganho)" })).toBe(true);
      expect(isTerminalColumn({ status_key: "sem_interesse", label: "Sem Interesse" })).toBe(true);
      expect(isTerminalColumn({ status_key: "descartado", label: "Descartado" })).toBe(true);
      expect(isTerminalColumn({ status_key: "em_qualificacao", label: "Em Qualificação" })).toBe(false);
      expect(isTerminalColumn({ status_key: "custom_end", label: "Qualquer", is_terminal: true })).toBe(true);
    });
  });

  describe("buildOrganizerSystemPrompt & buildAgentContextAppendix", () => {
    it("injeta o contexto do Agente de IA ativo e o guia semântico das colunas automaticamente", () => {
      const cols = [
        { status_key: "novo", label: "Novos Leads", order_index: 0 },
        { status_key: "primeiro_contato", label: "1º Contato", order_index: 1 },
        { status_key: "em_qualificacao", label: "Em Qualificação", order_index: 2 },
        { status_key: "previa_solicitada", label: "Prévia Solicitada", order_index: 3 },
      ];
      const activeAgent = {
        name: "Sarah SDR",
        role: "Especialista em Prospecção de Sites com Prévia Gratuita",
        main_prompt: "Ofereça uma prévia gratuita do site antes de falar de preços.",
      };

      const { systemPrompt } = buildOrganizerSystemPrompt(null, cols, new Date(), [], activeAgent);
      expect(systemPrompt).toContain("Sarah SDR");
      expect(systemPrompt).toContain("previa_solicitada");
      expect(systemPrompt).toContain("COMO LER A CONVERSA SEM ERRO");
      expect(buildAgentContextAppendix(activeAgent)).toContain("Ofereça uma prévia gratuita");
    });
  });
});
