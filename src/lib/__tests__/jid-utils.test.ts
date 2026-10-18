import { describe, it, expect } from "vitest";
import { normalizeJid, extractDigits } from "../jid-utils";

describe("jid-utils", () => {
  it("normaliza telefones com ou sem DDD/DDI para @s.whatsapp.net", () => {
    // 11 dígitos sem DDI
    expect(normalizeJid("11987654321")).toBe("5511987654321@s.whatsapp.net");
    // Formatado com parênteses e traço
    expect(normalizeJid("(11) 98765-4321")).toBe("5511987654321@s.whatsapp.net");
    // Com DDI 55
    expect(normalizeJid("5511987654321")).toBe("5511987654321@s.whatsapp.net");
    // Já formatado em JID
    expect(normalizeJid("5511987654321@s.whatsapp.net")).toBe("5511987654321@s.whatsapp.net");
    // JID de grupo
    expect(normalizeJid("123456789-987654@g.us")).toBe("123456789-987654@g.us");
    // Nulo ou vazio
    expect(normalizeJid(null)).toBeNull();
    expect(normalizeJid("")).toBeNull();
    expect(normalizeJid("   ")).toBeNull();
  });

  it("preserva números internacionais e remove apenas sufixo de dispositivo", () => {
    expect(normalizeJid("5511987654321:12@s.whatsapp.net")).toBe("5511987654321@s.whatsapp.net");
    expect(normalizeJid("+1 202 555 0123")).toBe("12025550123@s.whatsapp.net");
    expect(normalizeJid("5512345678")).toBe("555512345678@s.whatsapp.net");
  });

  it.each(["12", "0000000000", "1234567890123456", "abc1234567890", "123@lid", "1234567890@evil.test"])("rejeita número/JID inválido %s", (value) => {
    expect(normalizeJid(value)).toBeNull();
  });

  it("extrai dígitos numéricos corretamente", () => {
    expect(extractDigits("5511987654321@s.whatsapp.net")).toBe("5511987654321");
    expect(extractDigits("+55 (11) 98765-4321")).toBe("5511987654321");
    expect(extractDigits(null)).toBe("");
  });
});
