/**
 * Testa o agrupamento de modelos pros seletores (model-grouping.ts).
 *
 * POR QUE EXISTE: o seletor de modelo é usado em 7 telas (Agente, Disparo,
 * Configurações, Chat, etc). Se o agrupamento quebrar, modelos somem ou
 * aparecem duplicados. As funções são PURAS — sem React, sem DB.
 */
import { describe, it, expect } from "vitest";
import {
  modelFamily,
  isFreeModel,
  subGroupLabel,
  groupModels,
  PROVIDER_LABEL,
  type GroupableModel,
} from "../model-grouping";

describe("modelFamily — detecta marca do modelo", () => {
  it("mapeia vendor com slash (openrouter)", () => {
    expect(modelFamily("anthropic/claude-3.5-sonnet")).toBe("Claude");
    expect(modelFamily("openai/gpt-4o")).toBe("GPT (OpenAI)");
    expect(modelFamily("google/gemini-2.5-flash")).toBe("Gemini");
    expect(modelFamily("meta-llama/llama-3.1-70b")).toBe("Llama");
    expect(modelFamily("deepseek/deepseek-chat")).toBe("DeepSeek");
  });

  it("detecta por palavra-chave quando NÃO tem slash (gateway)", () => {
    expect(modelFamily("claude-3-5-sonnet")).toBe("Claude");
    expect(modelFamily("gpt-4o")).toBe("GPT (OpenAI)");
    expect(modelFamily("gemini-2.5-flash")).toBe("Gemini");
    expect(modelFamily("llama-3")).toBe("Llama");
    expect(modelFamily("glm-5")).toBe("GLM (Z-AI)");
  });

  it("case-insensitive", () => {
    expect(modelFamily("CLAUDE-3")).toBe("Claude");
    expect(modelFamily("GPT-4")).toBe("GPT (OpenAI)");
  });

  it("desconhecido com slash usa capitalize do vendor", () => {
    expect(modelFamily("acme/super-model")).toBe("Acme");
  });

  it("desconhecido sem slash cai em 'Outros'", () => {
    expect(modelFamily("xyz-123")).toBe("Outros");
    expect(modelFamily("")).toBe("Outros");
  });
});

describe("isFreeModel — convenção :free do OpenRouter", () => {
  it("true quando id termina em :free", () => {
    expect(isFreeModel({ id: "meta-llama/llama-3.1-70b:free", rawId: "meta-llama/llama-3.1-70b:free" })).toBe(true);
  });

  it("false para modelo pago", () => {
    expect(isFreeModel({ id: "openai/gpt-4o", rawId: "openai/gpt-4o" })).toBe(false);
  });

  it("case-insensitive no sufixo", () => {
    expect(isFreeModel({ id: "x/y:FREE", rawId: "x/y:FREE" })).toBe(true);
  });
});

describe("subGroupLabel — rótulo dentro do provedor", () => {
  it("openrouter grátis → 'Grátis' vem ANTES da família", () => {
    expect(
      subGroupLabel({
        id: "meta-llama/llama-3.1-70b:free",
        rawId: "meta-llama/llama-3.1-70b:free",
        provider: "openrouter",
      })
    ).toBe("Grátis");
  });

  it("openrouter pago → família do modelo", () => {
    expect(
      subGroupLabel({
        id: "anthropic/claude-3.5-sonnet",
        rawId: "anthropic/claude-3.5-sonnet",
        provider: "openrouter",
      })
    ).toBe("Claude");
  });

  it("gateway → sempre família (nunca 'Grátis')", () => {
    expect(
      subGroupLabel({
        id: "gpt-4o",
        rawId: "gpt-4o",
        provider: "gateway",
      })
    ).toBe("GPT (OpenAI)");
  });

  it("gemini → sem subgrupo (string vazia)", () => {
    expect(
      subGroupLabel({
        id: "gemini-2.5-flash",
        rawId: "gemini-2.5-flash",
        provider: "gemini",
      })
    ).toBe("");
  });
});

describe("groupModels — ordem provedor + subgrupos", () => {
  const models: GroupableModel[] = [
    { id: "gemini-2.5-flash", provider: "gemini" },
    { id: "openai/gpt-4o", provider: "openrouter" },
    { id: "meta-llama/llama-3:free", rawId: "meta-llama/llama-3:free", provider: "openrouter" },
    { id: "claude-3-5", rawId: "claude-3-5", provider: "gateway" },
    { id: "gpt-4o-mini", rawId: "gpt-4o-mini", provider: "gateway" },
  ];

  it("ordena provedores: gemini → openrouter → gateway", () => {
    const groups = groupModels(models);
    expect(groups.map((g) => g.provider)).toEqual(["gemini", "openrouter", "gateway"]);
  });

  it("openrouter: 'Grátis' vem antes de famílias pagas", () => {
    const groups = groupModels(models);
    const or = groups.find((g) => g.provider === "openrouter")!;
    expect(or.subgroups[0].label).toBe("Grátis");
    expect(or.subgroups[1].label).toBe("GPT (OpenAI)");
  });

  it("gateway: agrupa por família (GPT, Claude)", () => {
    const groups = groupModels(models);
    const gw = groups.find((g) => g.provider === "gateway")!;
    const labels = gw.subgroups.map((s) => s.label);
    expect(labels).toContain("Claude");
    expect(labels).toContain("GPT (OpenAI)");
  });

  it("lista vazia → sem grupos", () => {
    expect(groupModels([])).toEqual([]);
  });

  it("PROVIDER_LABEL tem os 3 provedores", () => {
    expect(PROVIDER_LABEL.gemini).toBeTruthy();
    expect(PROVIDER_LABEL.openrouter).toBeTruthy();
    expect(PROVIDER_LABEL.gateway).toBeTruthy();
  });
});
