import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST, PATCH } from "../route";

vi.mock("@/lib/tenant", () => ({
  requireClientId: vi.fn(),
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: vi.fn(),
  },
}));

describe("API /api/tasks/goal-trigger", () => {
  let mockRequireClientId: any;
  let mockSupabase: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const tenantMod = await import("@/lib/tenant");
    const supaMod = await import("@/lib/supabase_admin");
    mockRequireClientId = tenantMod.requireClientId;
    mockSupabase = supaMod.supabaseAdmin;
  });

  it("retorna 401 se não autenticado", async () => {
    mockRequireClientId.mockResolvedValueOnce({
      ok: false,
      response: new Response(JSON.stringify({ error: "Não autenticado" }), { status: 401 }),
    });

    const req = new NextRequest("http://localhost:3000/api/tasks/goal-trigger");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("GET retorna as configurações atuais do tenant", async () => {
    mockRequireClientId.mockResolvedValueOnce({
      ok: true,
      clientId: "tenant-uuid-1",
    });

    mockSupabase.from.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              features: {
                goal_task_trigger: {
                  enabled: true,
                  deadline_value: 3,
                  deadline_unit: "business_days",
                  model: "gemini:gemini-2.5-flash",
                  prompt: "Instrução de teste",
                },
              },
              default_ai_model: "gemini:gemini-2.5-flash",
            },
            error: null,
          }),
        }),
      }),
    });

    const req = new NextRequest("http://localhost:3000/api/tasks/goal-trigger");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.config.enabled).toBe(true);
    expect(json.config.deadline_value).toBe(3);
    expect(json.config.deadline_unit).toBe("business_days");
    expect(json.config.model).toBe("gemini:gemini-2.5-flash");
    expect(json.config.prompt).toBe("Instrução de teste");
  });

  it("POST atualiza as configurações em clients.features e salva no banco", async () => {
    mockRequireClientId.mockResolvedValueOnce({
      ok: true,
      clientId: "tenant-uuid-1",
    });

    let updatedFeatures: any = null;

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "clients") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  features: { existing_feature: true },
                },
                error: null,
              }),
            }),
          }),
          update: vi.fn().mockImplementation((payload) => {
            updatedFeatures = payload.features;
            return {
              eq: vi.fn().mockResolvedValue({ error: null }),
            };
          }),
        };
      }
      return { select: vi.fn().mockReturnThis() };
    });

    const req = new NextRequest("http://localhost:3000/api/tasks/goal-trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        deadline_value: 5,
        deadline_unit: "days",
        model: "openrouter:google/gemini-2.5-flash",
        prompt: "Nova instrução para tarefa",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.config.enabled).toBe(true);
    expect(json.config.deadline_value).toBe(5);
    expect(json.config.deadline_unit).toBe("days");

    // Verifica se features existentes foram preservadas e nova config foi gravada
    expect(updatedFeatures.existing_feature).toBe(true);
    expect(updatedFeatures.goal_task_trigger.enabled).toBe(true);
    expect(updatedFeatures.goal_task_trigger.deadline_value).toBe(5);
  });
});

