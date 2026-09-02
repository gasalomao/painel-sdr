import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const maybeSingle = vi.fn(async () => ({
  data: { openrouter_api_key: "sk-or-teste", api_key: "g-teste" },
  error: null,
}));
const eq = vi.fn((_col: string, _val: unknown) => ({ maybeSingle }));
const select = vi.fn((_cols: string) => ({ eq }));
const fromAdmin = vi.fn((_table: string) => ({ select }));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: fromAdmin },
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table === "ai_organizer_config") {
        throw new Error("anon não deve ler ai_organizer_config");
      }
      return { select: vi.fn() };
    }),
  },
}));

function mockFetchList(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
  );
}

describe("model discovery usa service role para ler ai_organizer_config", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("openrouter lista modelos mesmo com anon bloqueado", async () => {
    mockFetchList({
      data: [
        {
          id: "openrouter/auto",
          name: "Auto",
          architecture: { output_modalities: ["text"] },
          supported_parameters: ["tools"],
        },
      ],
    });
    const { listAvailableOpenRouterModels } = await import("@/lib/openrouter-model-discovery");
    const models = await listAvailableOpenRouterModels(true);
    expect(fromAdmin).toHaveBeenCalledWith("ai_organizer_config");
    expect(models.map((m) => m.id)).toContain("openrouter/auto");
  });

  it("gemini lista modelos mesmo com anon bloqueado", async () => {
    mockFetchList({
      models: [
        {
          name: "models/gemini-2.5-flash",
          displayName: "Gemini 2.5 Flash",
          supportedGenerationMethods: ["generateContent"],
        },
      ],
    });
    const { listAvailableGeminiModels } = await import("@/lib/gemini-model-discovery");
    const models = await listAvailableGeminiModels(true);
    expect(fromAdmin).toHaveBeenCalledWith("ai_organizer_config");
    expect(models.map((m) => m.id)).toContain("gemini-2.5-flash");
  });
});
