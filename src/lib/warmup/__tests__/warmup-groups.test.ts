import { describe, it, expect } from "vitest";
import { parseGroupInviteCodes } from "../warmup-groups";
import { PURPOSE_METADATA, type WarmupPurpose } from "../warmup-types";

describe("Warmup Groups & Swarm Engine", () => {
  describe("parseGroupInviteCodes", () => {
    it("extrai links completos de WhatsApp de texto multilinhas", () => {
      const input = `
        https://chat.whatsapp.com/G34A1B2C3D4E5F6G7H8I9J
        https://chat.whatsapp.com/L99Z8Y7X6W5V4U3T2S1R0Q
      `;
      const parsed = parseGroupInviteCodes(input);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].code).toBe("G34A1B2C3D4E5F6G7H8I9J");
      expect(parsed[0].url).toBe("https://chat.whatsapp.com/G34A1B2C3D4E5F6G7H8I9J");
      expect(parsed[1].code).toBe("L99Z8Y7X6W5V4U3T2S1R0Q");
    });

    it("lida com URLs sem https:// e códigos avulsos", () => {
      const input = `
        chat.whatsapp.com/ABC1234567890123456789
        XYZ9876543210987654321
        invalido
      `;
      const parsed = parseGroupInviteCodes(input);
      expect(parsed).toHaveLength(2);
      expect(parsed.map((p) => p.code)).toContain("ABC1234567890123456789");
      expect(parsed.map((p) => p.code)).toContain("XYZ9876543210987654321");
    });

    it("remove códigos duplicados automaticamente", () => {
      const input = `
        https://chat.whatsapp.com/G34A1B2C3D4E5F6G7H8I9J
        https://chat.whatsapp.com/G34A1B2C3D4E5F6G7H8I9J
        G34A1B2C3D4E5F6G7H8I9J
      `;
      const parsed = parseGroupInviteCodes(input);
      expect(parsed).toHaveLength(1);
    });

    it("retorna lista vazia para strings nulas ou em branco", () => {
      expect(parseGroupInviteCodes("")).toEqual([]);
      expect(parseGroupInviteCodes("   \n   \r\n  ")).toEqual([]);
    });
  });

  describe("Finalidade do Chip (Purpose Calibration)", () => {
    it("possui os 3 perfis calibrados corretamente", () => {
      const contingency = PURPOSE_METADATA.contingency;
      const inbound = PURPOSE_METADATA.inbound;
      const outbound = PURPOSE_METADATA.outbound;

      expect(contingency.minDays).toBe(7);
      expect(contingency.dailyCap).toBe(20);

      expect(inbound.minDays).toBe(15);
      expect(inbound.dailyCap).toBe(40);

      expect(outbound.minDays).toBe(30);
      expect(outbound.dailyCap).toBe(70);
    });

    it("todos os perfis possuem rótulos e textos explicativos claros", () => {
      const purposes: WarmupPurpose[] = ["contingency", "inbound", "outbound"];
      for (const p of purposes) {
        const meta = PURPOSE_METADATA[p];
        expect(meta.name).toBeTruthy();
        expect(meta.badge).toBeTruthy();
        expect(meta.recommendedDays).toBeTruthy();
        expect(meta.description).toBeTruthy();
        expect(meta.targetUse).toBeTruthy();
      }
    });
  });

  describe("Heurísticas de Sentimento Zero-Token", () => {
    it("reconhece saudações e saudações informais em pt-BR", () => {
      const regex = /\b(bom dia|diaa+|bom diaa+|dia abençoado|ótimo dia)\b/i;
      expect(regex.test("Bom dia pessoal!")).toBe(true);
      expect(regex.test("dia abençoado a todos")).toBe(true);
      expect(regex.test("bom diaaa")).toBe(true);
      expect(regex.test("apenas um texto qualquer")).toBe(false);
    });

    it("reconhece celebrações e parabenizações corporativas", () => {
      const regex = /\b(parab[eé]ns|felicidades|sucesso|meta batida|consegui|fechou|fechado|bora pra cima|pra cima)\b/i;
      expect(regex.test("Parabéns pela conquista!")).toBe(true);
      expect(regex.test("Meta batida hoje")).toBe(true);
      expect(regex.test("Bora pra cima time")).toBe(true);
    });

    it("reconhece agradecimentos e respeito mútuo", () => {
      const regex = /\b(obrigad[oa]|valeu|gratid[aã]o|am[eé]m|show|top|sensacional|muito bom|excelente)\b/i;
      expect(regex.test("Obrigado pela dica")).toBe(true);
      expect(regex.test("Valeu demais")).toBe(true);
      expect(regex.test("Show de bola")).toBe(true);
    });
  });
});
