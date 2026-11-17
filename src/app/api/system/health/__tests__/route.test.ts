// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  clientId: "tenant-1",
  connections: [] as Array<Record<string, unknown>>,
  agents: [] as Array<Record<string, unknown>>,
  logs: [] as Array<Record<string, unknown>>,
  aiKeys: { gemini: "g-key", openrouter: "or-key", openrouterKeys: [], nvidia: null, nvidiaAccounts: [], gatewayBaseUrl: null } as Record<string, unknown>,
  missingRescheduleRpc: false,
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: vi.fn(async () => ({ ok: true, clientId: state.clientId, isAdmin: true })),
}));
vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: vi.fn(async () => state.aiKeys),
}));
vi.mock("@/lib/internal-auth", () => ({
  getInternalSecret: () => "internal-sec",
}));
vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        gte: () => chain,
        order: () => chain,
        limit: () => chain,
        then: (res: (v: { data: unknown[]; error: null }) => void) => {
          const rows =
            table === "channel_connections"
              ? state.connections
              : table === "webhook_logs"
                ? state.logs
                : table === "agent_settings"
                  ? state.agents
                  : [{ id: 1 }];
          return Promise.resolve({ data: rows, error: null }).then(res);
        },
      };
      return chain;
    },
    rpc: vi.fn(async (name: string) => {
      if (name === "reschedule_agent_followup" && state.missingRescheduleRpc) {
        return { data: null, error: { message: "Could not find the function public.reschedule_agent_followup" } };
      }
      return { data: null, error: { message: "followup_invalid_claim" } };
    }),
  },
}));

describe("GET /api/system/health", () => {
  beforeEach(() => {
    vi.stubEnv("AGENT_FOLLOWUP_WORKER_ENABLED", "true");
    state.connections = [{ instance_name: "wa-1", status: "open", provider: "evolution" }];
    state.agents = [{ id: 1, name: "Sarah", is_active: true, is_scheduler: true, options: { google_tokens: { refresh_token: "rt-1" } } }];
    state.logs = [];
    state.aiKeys = { gemini: "g-key", openrouter: "or-key", openrouterKeys: [], nvidia: null, nvidiaAccounts: [], gatewayBaseUrl: null };
    state.missingRescheduleRpc = false;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("retorna overall ok quando WhatsApp, IA, Google Agenda e workers estão saudáveis", async () => {
    const { GET } = await import("../route");
    const res = await GET(new NextRequest("http://localhost/api/system/health"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.overall).toBe("ok");
    expect(json.checks).toHaveLength(4);
    expect(json.checks.every((c: { status: string }) => c.status === "ok")).toBe(true);
    // Nunca vaza chaves ou tokens
    expect(JSON.stringify(json)).not.toContain("g-key");
    expect(JSON.stringify(json)).not.toContain("rt-1");
  });

  it("detecta migration 029 pendente e ausência de Google Calendar em agente agendador", async () => {
    state.missingRescheduleRpc = true;
    state.agents = [{ id: 2, name: "Agendador Sem Token", is_active: true, is_scheduler: true, options: {} }];

    const { GET } = await import("../route");
    const res = await GET(new NextRequest("http://localhost/api/system/health"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.overall).toBe("warn");
    const cal = json.checks.find((c: { id: string }) => c.id === "calendar");
    const dbCheck = json.checks.find((c: { id: string }) => c.id === "workers_db");
    expect(cal.status).toBe("warn");
    expect(dbCheck.summary).toContain("migration 029");
  });
});

