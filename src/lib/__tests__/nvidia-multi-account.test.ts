import { describe, it, expect } from "vitest";
import { parseNvidiaAccounts } from "../ai-keys";
import { normalizeNvidiaModelKey } from "../nvidia-model-discovery";
import { findPriceFor } from "../pricing";

describe("parseNvidiaAccounts", () => {
  it("devolve conta principal a partir de chave legada quando lista estiver vazia", () => {
    const accounts = parseNvidiaAccounts(null, "nvapi-legacy-123");
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toEqual({
      id: "primary",
      label: "Principal",
      apiKey: "nvapi-legacy-123",
    });
  });

  it("parseia array de contas nomeadas preservando ids e labels", () => {
    const raw = [
      { id: "nv_1", label: "Conta Pessoal", apiKey: "nvapi-key-1" },
      { id: "nv_2", label: "Conta Empresa", api_key: "nvapi-key-2" },
    ];
    const accounts = parseNvidiaAccounts(raw, null);
    expect(accounts).toHaveLength(2);
    expect(accounts[0].label).toBe("Conta Pessoal");
    expect(accounts[0].apiKey).toBe("nvapi-key-1");
    expect(accounts[1].label).toBe("Conta Empresa");
    expect(accounts[1].apiKey).toBe("nvapi-key-2");
  });

  it("suporta string JSON no input", () => {
    const jsonStr = JSON.stringify([
      { id: "a1", label: "Dev", apiKey: "nvapi-dev" },
      { id: "a2", label: "Prod", apiKey: "nvapi-prod" },
    ]);
    const accounts = parseNvidiaAccounts(jsonStr, null);
    expect(accounts).toHaveLength(2);
    expect(accounts[0].apiKey).toBe("nvapi-dev");
    expect(accounts[1].apiKey).toBe("nvapi-prod");
  });

  it("deduplica contas com a mesma chave", () => {
    const raw = [
      { id: "nv_1", label: "Conta 1", apiKey: "nvapi-same-key" },
      { id: "nv_2", label: "Conta 2", apiKey: "nvapi-same-key" },
    ];
    const accounts = parseNvidiaAccounts(raw, null);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe("nv_1");
  });

  it("retorna vazio se não houver contas nem chave legada", () => {
    const accounts = parseNvidiaAccounts([], null);
    expect(accounts).toEqual([]);
  });
});

describe("normalizeNvidiaModelKey", () => {
  it("remove prefixo de vendor e normaliza underscores", () => {
    expect(normalizeNvidiaModelKey("nvidia/nemotron-3.5-lightning-30b-a3b")).toBe("nemotron-3.5-lightning-30b-a3b");
    expect(normalizeNvidiaModelKey("meta/llama-3.2-11b-vision-instruct")).toBe("llama-3.2-11b-vision-instruct");
    expect(normalizeNvidiaModelKey("google/diffusiongemma-26b-a4b-it")).toBe("diffusiongemma-26b-a4b-it");
  });

  it("converte para minúsculas e troca _ por -", () => {
    expect(normalizeNvidiaModelKey("NVIDIA/Nemotron_3.5_Lightning")).toBe("nemotron-3.5-lightning");
  });
});

describe("findPriceFor com prefixo nvidia", () => {
  it("faz strip de prefixo nvidia: sem retornar erro", () => {
    const map = {
      "meta/llama-3.1-70b-instruct": {
        input_per_token: 0.00000035,
        output_per_token: 0.0000004,
      },
    };
    const price = findPriceFor(map, "nvidia:meta/llama-3.1-70b-instruct");
    expect(price).toBeDefined();
    expect(price?.input_per_token).toBe(0.00000035);
  });
});
