import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { maskJid, truncForLog } from "../pii";

describe("maskJid", () => {
  it("retorna string vazia para null/undefined/vazio", () => {
    expect(maskJid(null)).toBe("");
    expect(maskJid(undefined)).toBe("");
    expect(maskJid("")).toBe("");
  });

  it("mascara JID padrão WhatsApp", () => {
    expect(maskJid("5511999998888@s.whatsapp.net")).toBe("5511***88@s.whatsapp.net");
  });

  it("mascara número sem sufixo @", () => {
    expect(maskJid("5511999998888")).toBe("5511***88");
  });

  it("não mascara se telefone < 8 chars (não há o que esconder)", () => {
    expect(maskJid("1234567")).toBe("1234567");
    expect(maskJid("1234567@x.y")).toBe("1234567@x.y");
  });

  it("preserva sufixo @ exatamente", () => {
    expect(maskJid("5511988887777@g.us")).toBe("5511***77@g.us");
  });
});

describe("truncForLog", () => {
  it("retorna vazio pra null/undefined/vazio", () => {
    expect(truncForLog(null)).toBe("");
    expect(truncForLog(undefined)).toBe("");
    expect(truncForLog("")).toBe("");
  });

  it("não trunca quando ≤ max", () => {
    expect(truncForLog("oi", 10)).toBe("oi");
    expect(truncForLog("a".repeat(60))).toBe("a".repeat(60));
  });

  it("trunca e adiciona reticências quando passa max", () => {
    const out = truncForLog("a".repeat(100), 10);
    expect(out).toBe("aaaaaaaaaa…");
  });

  it("colapsa whitespace múltiplo", () => {
    expect(truncForLog("oi   \n\n  mundo")).toBe("oi mundo");
  });

  it("usa max default = 60", () => {
    const long = "x".repeat(200);
    const out = truncForLog(long);
    expect(out.length).toBe(61); // 60 + ellipsis
  });
});

describe("modo DEBUG_PII", () => {
  const ORIGINAL = process.env.DEBUG_PII;
  beforeEach(() => {
    delete process.env.DEBUG_PII;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DEBUG_PII;
    else process.env.DEBUG_PII = ORIGINAL;
  });

  it("máscara default está ativa (DEBUG_PII != 1)", () => {
    expect(maskJid("5511999998888@s.whatsapp.net")).toContain("***");
  });
});
