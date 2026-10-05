import { describe, it, expect, vi, beforeEach } from "vitest";
import { listAvailableNvidiaModels, invalidateNvidiaModelsCache } from "../nvidia-model-discovery";
import * as aiKeysModule from "../ai-keys";

describe("nvidia-model-discovery", () => {
  beforeEach(() => {
    invalidateNvidiaModelsCache();
    vi.restoreAllMocks();
  });

  it("retorna lista vazia se chave NVIDIA não estiver configurada", async () => {
    vi.spyOn(aiKeysModule, "getAiKeys").mockResolvedValue({
      ...aiKeysModule.EMPTY_KEYS,
      gemini: "test",
      nvidia: null,
    });

    const models = await listAvailableNvidiaModels(true);
    expect(models).toEqual([]);
  });

  it("filtra embeddings e rerank e mapeia modelos de chat da NVIDIA", async () => {
    vi.spyOn(aiKeysModule, "getAiKeys").mockResolvedValue({
      ...aiKeysModule.EMPTY_KEYS,
      gemini: "test",
      nvidia: "nvapi-fake-key",
    });

    const fakeResponse = {
      data: [
        { id: "nvidia/llama-3.1-nemotron-70b-instruct", owned_by: "nvidia" },
        { id: "nvidia/nv-embedqa-e5-v5", owned_by: "nvidia" },
        { id: "nvidia/reranking-model", owned_by: "nvidia" },
        { id: "meta/llama-3.3-70b-instruct", owned_by: "meta" },
      ],
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => fakeResponse,
    });
    vi.stubGlobal("fetch", fetchMock);

    const models = await listAvailableNvidiaModels(true);

    expect(fetchMock).toHaveBeenCalled();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("nvidia/llama-3.1-nemotron-70b-instruct");
    expect(ids).toContain("meta/llama-3.3-70b-instruct");
    expect(ids).not.toContain("nvidia/nv-embedqa-e5-v5");
    expect(ids).not.toContain("nvidia/reranking-model");
  });

  it("usa fallback quando fetch falha mas há chave configurada", async () => {
    vi.spyOn(aiKeysModule, "getAiKeys").mockResolvedValue({
      ...aiKeysModule.EMPTY_KEYS,
      gemini: "test",
      nvidia: "nvapi-fake-key",
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network offline")));

    const models = await listAvailableNvidiaModels(true);
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.id.includes("nemotron"))).toBe(true);
  });
});
