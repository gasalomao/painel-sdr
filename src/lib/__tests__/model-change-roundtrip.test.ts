/**
 * Testes determinísticos do roundtrip parseModelRef ⇄ formatModelRef.
 *
 * Isto é o que garante a "troca de modelo" no Agente de IA funcionar:
 *   - Usuário escolhe modelo X no dropdown (id cru, tipo "openai/gpt-4o")
 *   - Salvamos formatModelRef(provider, rawId) — ex "openrouter:openai/gpt-4o"
 *   - No agente, parseModelRef(ref) devolve { provider, model: rawId } correto
 *   - LLM recebe o rawId (sem prefixo pro OpenRouter/Gateway, com normalização pro Gemini)
 *
 * Antes os testes cobriam cada parse isoladamente. Este arquivo valida o ROUNDTRIP
 * (id salva ↔ id lido) e quebrar aqui = "troca de modelo" quebrada no painel.
 */
import { describe, it, expect } from "vitest";
import {
  parseModelRef,
  formatModelRef,
  providerOf,
  providerDisplayName,
  type AiProvider,
} from "../ai-provider";

describe("roundtrip parseModelRef ⇄ formatModelRef", () => {
  const cases: Array<{ name: string; provider: AiProvider; rawId: string; stored: string }> = [
    // Para Gemini, formatModelRef sempre sai "bare" (sem prefix) — retrocompat.
    // Mas parseModelRef aceita variações da string guardada (models/..., gemini:...)
    // e devolve o rawId canonizado pra baixo. Por isso o "stored" presume o formato
    // que o painel salva via formatModelRef, e o parse tem que saber ler o que veio.
    { name: "Gemini bare (legado)",        provider: "gemini",    rawId: "gemini-2.5-flash",            stored: "gemini-2.5-flash" },
    { name: "OpenRouter (OpenAI)",         provider: "openrouter", rawId: "openai/gpt-4o",              stored: "openrouter:openai/gpt-4o" },
    { name: "OpenRouter (Claude)",         provider: "openrouter", rawId: "anthropic/claude-3.5-sonnet", stored: "openrouter:anthropic/claude-3.5-sonnet" },
    { name: "OpenRouter (DeepSeek)",       provider: "openrouter", rawId: "deepseek/deepseek-chat",     stored: "openrouter:deepseek/deepseek-chat" },
    { name: "Gateway",                     provider: "gateway",  rawId: "gpt-5",                       stored: "gateway:gpt-5" },
  ];

  for (const c of cases) {
    it(`format → parse preserva rawId e provider: ${c.name}`, () => {
      const stored = formatModelRef(c.provider, c.rawId);
      // stored bate com snapshot esperado? (regressão de formato no DB)
      expect(stored).toBe(c.stored);
      // parse volta pros mesmos valores?
      const back = parseModelRef(stored);
      expect(back.provider).toBe(c.provider);
      expect(back.model).toBe(c.rawId);
    });
  }

  it("providerOf(stored) coerente com parseModelRef(stored).provider", () => {
    const providers: AiProvider[] = ["gemini", "openrouter", "gateway"];
    for (const p of providers) {
      const stored = formatModelRef(p, "any-id");
      expect(providerOf(stored)).toBe(p);
    }
  });
});

describe("parseModelRef — bordas e retrocompatibilidade", () => {
  it("string vazia → gemini default (não undefined)", () => {
    const r = parseModelRef("");
    expect(r.provider).toBe("gemini");
    expect(r.model).toBe("");
  });

  it("null → gemini default", () => {
    const r = parseModelRef(null);
    expect(r.provider).toBe("gemini");
    expect(r.model).toBe("");
  });

  it("undefined → gemini default", () => {
    const r = parseModelRef(undefined);
    expect(r.provider).toBe("gemini");
    expect(r.model).toBe("");
  });

  it("Gemini com prefix 'models/' é normalizado (strip)", () => {
    const r = parseModelRef("models/gemini-2.5-flash");
    expect(r.provider).toBe("gemini");
    expect(r.model).toBe("gemini-2.5-flash");
  });

  it("GATEWAY_PREFIX domina OPENROUTER_PREFIX (não pode confundir)", () => {
    // ex "gateway:openrouter:mistral" — gateway é externo, rawId mantém o que vier
    const r = parseModelRef("gateway:openrouter:mistral");
    expect(r.provider).toBe("gateway");
    expect(r.model).toBe("openrouter:mistral");
  });

  it("trim funciona (espaços nas pontas)", () => {
    const r = parseModelRef("  openrouter:openai/gpt-4o  ");
    expect(r.provider).toBe("openrouter");
    expect(r.model).toBe("openai/gpt-4o");
  });

  it("bare id sem prefix cai em gemini (retrocompatibilidade real)", () => {
    // legado: DB velho gravava só "gemini-1.5-pro" sem prefixo
    const r = parseModelRef("gemini-1.5-pro");
    expect(r.provider).toBe("gemini");
    expect(r.model).toBe("gemini-1.5-pro");
  });
});

describe("formatModelRef — invariantes de saída", () => {
  it("Gemini fica 'bare' (sem prefix) — retrocompat真的", () => {
    expect(formatModelRef("gemini", "gemini-2.5-flash")).toBe("gemini-2.5-flash");
  });

  it("OpenRouter sempre prefixado", () => {
    expect(formatModelRef("openrouter", "openai/gpt-4o")).toBe("openrouter:openai/gpt-4o");
  });

  it("Gateway sempre prefixado", () => {
    expect(formatModelRef("gateway", "gpt-5")).toBe("gateway:gpt-5");
  });

  it("model vazio → só prefix (caso degradado)", () => {
    expect(formatModelRef("openrouter", "")).toBe("openrouter:");
    expect(formatModelRef("gateway", "")).toBe("gateway:");
  });

  it("trim do model antes de formatar", () => {
    expect(formatModelRef("gemini", "  gemini-2.5-flash  ")).toBe("gemini-2.5-flash");
  });
});

describe("providerDisplayName — labels canônicos", () => {
  it("gemini → 'Gemini'", () => {
    expect(providerDisplayName("gemini")).toBe("Gemini");
  });
  it("openrouter → 'OpenRouter'", () => {
    expect(providerDisplayName("openrouter")).toBe("OpenRouter");
  });
  it("gateway → 'Gateway'", () => {
    expect(providerDisplayName("gateway")).toBe("Gateway");
  });
});
