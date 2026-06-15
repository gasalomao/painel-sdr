import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetCfg = vi.fn();
const mockMaybeSingle = vi.fn();
const mockListModels = vi.fn();
const mockPickBest = vi.fn();

vi.mock("@/lib/organizer-config-cache", () => ({
  getOrganizerConfig: mockGetCfg,
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: mockMaybeSingle,
        }),
      }),
    }),
  },
}));

// Descoberta dinâmica de modelos é mockada nos testes — controlamos o que
// "está disponível" pra exercitar o redirect quando o modelo pedido sumiu.
vi.mock("@/lib/gemini-model-discovery", () => ({
  listAvailableGeminiModels: mockListModels,
  pickBestFlashModel: mockPickBest,
  getCachedFlashModel: () => null,
}));

beforeEach(() => {
  mockGetCfg.mockReset();
  mockMaybeSingle.mockReset();
  mockListModels.mockReset();
  mockPickBest.mockReset();
  // Default: sem descoberta possível → mapModelAsync devolve input normalizado
  mockListModels.mockResolvedValue([]);
  mockPickBest.mockResolvedValue(null);
});

describe("mapModel (sync) — só normaliza prefixo, não valida", () => {
  it("normaliza models/ prefix", async () => {
    const { mapModel } = await import("../ai-default-model");
    expect(mapModel("models/gemini-2.5-flash")).toBe("gemini-2.5-flash");
  });

  it("retorna null pra entrada vazia/null", async () => {
    const { mapModel } = await import("../ai-default-model");
    expect(mapModel(null)).toBeNull();
    expect(mapModel(undefined)).toBeNull();
    expect(mapModel("")).toBeNull();
    expect(mapModel("   ")).toBeNull();
  });

  it("trim", async () => {
    const { mapModel } = await import("../ai-default-model");
    expect(mapModel("  gemini-x  ")).toBe("gemini-x");
  });

  it("NÃO redireciona modelo deprecated — isso virou responsabilidade do async", async () => {
    const { mapModel } = await import("../ai-default-model");
    expect(mapModel("gemini-1.5-flash")).toBe("gemini-1.5-flash");
  });
});

describe("mapModelAsync — valida contra lista real da Google", () => {
  it("devolve modelo se está na lista disponível", async () => {
    mockListModels.mockResolvedValue([
      { id: "gemini-2.5-flash", displayName: "Flash" },
      { id: "gemini-2.5-pro", displayName: "Pro" },
    ]);
    const { mapModelAsync } = await import("../ai-default-model");
    expect(await mapModelAsync("gemini-2.5-flash")).toBe("gemini-2.5-flash");
  });

  it("redireciona pro best quando modelo pedido sumiu", async () => {
    mockListModels.mockResolvedValue([{ id: "gemini-2.5-flash", displayName: "Flash" }]);
    mockPickBest.mockResolvedValue("gemini-2.5-flash");
    const { mapModelAsync } = await import("../ai-default-model");
    expect(await mapModelAsync("gemini-3.1-flash-lite-preview")).toBe("gemini-2.5-flash");
  });

  it("devolve input quando não consegue descobrir (sem API key)", async () => {
    mockListModels.mockResolvedValue([]);
    const { mapModelAsync } = await import("../ai-default-model");
    expect(await mapModelAsync("gemini-qualquer")).toBe("gemini-qualquer");
  });

  it("devolve null pra null", async () => {
    const { mapModelAsync } = await import("../ai-default-model");
    expect(await mapModelAsync(null)).toBeNull();
  });
});

describe("resolveModel", () => {
  it("usa optsModel quando passado e válido", async () => {
    mockGetCfg.mockResolvedValue({ model: "gemini-fallback" });
    const { resolveModel } = await import("../ai-default-model");
    expect(await resolveModel("gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(mockGetCfg).not.toHaveBeenCalled();
  });

  it("ignora optsModel vazio/whitespace e cai pro default", async () => {
    mockGetCfg.mockResolvedValue({ model: "gemini-cfg" });
    const { resolveModel } = await import("../ai-default-model");
    expect(await resolveModel("")).toBe("gemini-cfg");
    expect(await resolveModel("   ")).toBe("gemini-cfg");
    expect(await resolveModel(null)).toBe("gemini-cfg");
    expect(await resolveModel(undefined)).toBe("gemini-cfg");
  });

  it("trim em optsModel passado", async () => {
    const { resolveModel } = await import("../ai-default-model");
    expect(await resolveModel("  gemini-x  ")).toBe("gemini-x");
  });

  it("retorna null se nem opts nem config têm modelo", async () => {
    mockGetCfg.mockResolvedValue({ model: null });
    const { resolveModel } = await import("../ai-default-model");
    expect(await resolveModel()).toBeNull();
  });

  it("retorna null se config inteiro é null", async () => {
    mockGetCfg.mockResolvedValue(null);
    const { resolveModel } = await import("../ai-default-model");
    expect(await resolveModel()).toBeNull();
  });

  it("trim no modelo vindo do config", async () => {
    mockGetCfg.mockResolvedValue({ model: "  gemini-z  " });
    const { resolveModel } = await import("../ai-default-model");
    expect(await resolveModel()).toBe("gemini-z");
  });
});

describe("getDefaultModel", () => {
  it("retorna modelo do config quando válido", async () => {
    mockGetCfg.mockResolvedValue({ model: "gemini-cfg" });
    const { getDefaultModel } = await import("../ai-default-model");
    expect(await getDefaultModel()).toBe("gemini-cfg");
  });

  it("retorna null quando config sem modelo", async () => {
    mockGetCfg.mockResolvedValue({ model: "" });
    const { getDefaultModel } = await import("../ai-default-model");
    expect(await getDefaultModel()).toBeNull();
  });

  it("redireciona modelo morto quando descoberta está disponível", async () => {
    mockGetCfg.mockResolvedValue({ model: "gemini-3.1-flash-lite-preview" });
    mockListModels.mockResolvedValue([{ id: "gemini-2.5-flash", displayName: "Flash" }]);
    mockPickBest.mockResolvedValue("gemini-2.5-flash");
    const { getDefaultModel } = await import("../ai-default-model");
    expect(await getDefaultModel()).toBe("gemini-2.5-flash");
  });
});
