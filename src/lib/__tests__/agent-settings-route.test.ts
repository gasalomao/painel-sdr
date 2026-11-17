import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  auth: {
    ok: true as const,
    clientId: "tenant-a",
    isAdmin: false,
    impersonating: false,
    claims: {
      clientId: "tenant-a",
      isAdmin: false,
      impersonating: false,
      sessionId: "sess-1",
    },
  },
  agentRows: [] as Array<Record<string, unknown>>,
  stageRows: [] as Array<Record<string, unknown>>,
  kbRows: [] as Array<Record<string, unknown>>,
  channelRows: [] as Array<Record<string, unknown>>,
  agentSettingsQueries: 0,
  updatedPayloads: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: vi.fn(async () => state.auth),
}));

vi.mock("@/lib/supabase_admin", () => {
  const from = vi.fn((table: string) => {
    const filters: Array<[string, unknown]> = [];
    let neqFilter: [string, unknown] | null = null;
    let action: "select" | "update" | "insert" | "upsert" | "delete" = "select";
    let writePayload: Record<string, unknown> | null = null;

    const matchRows = (rows: Array<Record<string, unknown>>) =>
      rows.filter((r) => {
        for (const [k, v] of filters) {
          if (r[k] !== v) return false;
        }
        if (neqFilter && r[neqFilter[0]] === neqFilter[1]) return false;
        return true;
      });

    const execute = () => {
      if (table === "agent_settings") {
        if (action === "select") {
          state.agentSettingsQueries += 1;
          return matchRows(state.agentRows);
        }
        if (action === "update" && writePayload) {
          state.updatedPayloads.push(writePayload);
          const matched = matchRows(state.agentRows);
          if (matched.length === 0) return [];
          const updated = { ...matched[0], ...writePayload };
          state.agentRows = state.agentRows.map((r) => (r.id === updated.id ? updated : r));
          return [updated];
        }
        if (action === "delete") {
          const matched = matchRows(state.agentRows);
          const matchedIds = new Set(matched.map((r) => r.id));
          state.agentRows = state.agentRows.filter((r) => !matchedIds.has(r.id));
          return matched;
        }
      }
      if (table === "agent_stages") return matchRows(state.stageRows);
      if (table === "agent_knowledge") {
        const agentFilter = filters.find(([k]) => k === "agent_id")?.[1];
        return state.kbRows.filter((r) => agentFilter === undefined || r.agent_id === agentFilter);
      }
      if (table === "channel_connections") {
        if (action === "upsert" && writePayload) return [writePayload];
        return matchRows(state.channelRows);
      }
      return [];
    };

    const builder = {
      select: () => builder,
      update: (payload: Record<string, unknown>) => {
        action = "update";
        writePayload = payload;
        return builder;
      },
      insert: (payload: Record<string, unknown>) => {
        action = "insert";
        writePayload = payload;
        return builder;
      },
      upsert: (payload: Record<string, unknown>) => {
        action = "upsert";
        writePayload = payload;
        return builder;
      },
      delete: () => {
        action = "delete";
        return builder;
      },
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        return builder;
      },
      neq: (k: string, v: unknown) => {
        neqFilter = [k, v];
        return builder;
      },
      or: () => builder,
      order: () => builder,
      limit: () => builder,
      single: async () => {
        const rows = execute();
        return { data: rows[0] ?? null, error: rows[0] ? null : { message: "Not found" } };
      },
      maybeSingle: async () => {
        const rows = execute();
        return { data: rows[0] ?? null, error: null };
      },
      then: (resolve: (res: { data: unknown; error: null }) => void) => {
        resolve({ data: execute(), error: null });
      },
    };
    return builder;
  });

  return { supabaseAdmin: { from } };
});

import { GET, PATCH, POST, DELETE } from "@/app/api/agent/settings/route";
import {
  clearAgentConfigCache,
  getCachedAgentStaticBundle,
  invalidateAgentConfigCache,
} from "@/lib/agent-config-cache";

describe("/api/agent/settings BFF + agent-config-cache", () => {
  beforeEach(() => {
    vi.useRealTimers();
    clearAgentConfigCache();
    state.auth = {
      ok: true,
      clientId: "tenant-a",
      isAdmin: false,
      impersonating: false,
      claims: { clientId: "tenant-a", isAdmin: false, impersonating: false, sessionId: "sess-1" },
    };
    state.agentRows = [
      {
        id: 10,
        client_id: "tenant-a",
        name: "Vendedor A",
        role: "SDR",
        personality: "Direto",
        tone: "Consultivo",
        main_prompt: "Ajude o cliente.",
        target_model: "google/gemini-2.5-flash",
        is_active: true,
        is_scheduler: true,
        scheduler_config: {
          owner_summary_model: "google/gemini-2.5-flash-lite",
          reminders: [],
        },
        options: {
          google_tokens: { access_token: "ya29.secret", refresh_token: "1//secret-refresh" },
          google_credentials: '{"web":{"client_secret":"top-secret"}}',
          gemini_api_key: "AIzaSecretKey",
          openrouter_api_key: "sk-or-secret",
          nvidia_api_key: "nvapi-secret",
          calendar_connected_email: "agenda@empresa.com",
          message_buffer_seconds: 5,
        },
      },
      {
        id: 20,
        client_id: "tenant-b",
        name: "Agente Tenant B",
        target_model: "google/gemini-2.5-pro",
        options: {},
      },
    ];
    state.stageRows = [
      { id: "st-1", agent_id: 10, client_id: "tenant-a", title: "Qualificação", order_index: 0 },
    ];
    state.kbRows = [
      { id: "kb-1", agent_id: 10, client_id: "tenant-a", title: "Catálogo VIP", content: "[IMAGEM: https://cdn.example.com/a.jpg]" },
    ];
    state.channelRows = [
      { instance_name: "inst-b", agent_id: 20, client_id: "tenant-b" },
      { instance_name: "inst-a-other", agent_id: 11, client_id: "tenant-a" },
    ];
    state.agentSettingsQueries = 0;
    state.updatedPayloads = [];
  });

  it("GET mascara tokens/credenciais/keys e expõe flags seguras", async () => {
    const req = new NextRequest("http://localhost/api/agent/settings?agent_id=10");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.agent.options.google_tokens).toBeUndefined();
    expect(json.agent.options.google_credentials).toBeUndefined();
    expect(json.agent.options.gemini_api_key).toBeUndefined();
    expect(json.agent.options.openrouter_api_key).toBeUndefined();
    expect(json.agent.options.nvidia_api_key).toBeUndefined();

    expect(json.agent.options.google_connected).toBe(true);
    expect(json.agent.options.has_custom_google_credentials).toBe(true);
    expect(json.agent.options.calendar_connected_email).toBe("agenda@empresa.com");
    expect(json.agent.options.message_buffer_seconds).toBe(5);
  });

  it("PATCH não-admin ignora troca forjada de target_model e preserva segredos em options", async () => {
    const req = new NextRequest("http://localhost/api/agent/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: 10,
        section: "identity",
        name: "Novo Nome",
        role: "Closer",
        personality: "Calmo",
        tone: "Formal",
        target_model: "openai/gpt-4o",
        options: {
          message_buffer_seconds: 8,
          google_tokens: { refresh_token: "hacked" },
          gemini_api_key: "hacked",
        },
      }),
    });

    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(state.updatedPayloads[0].target_model).toBe("google/gemini-2.5-flash");
    const savedOpts = state.updatedPayloads[0].options as Record<string, unknown>;
    expect(savedOpts.google_tokens).toEqual({ access_token: "ya29.secret", refresh_token: "1//secret-refresh" });
    expect(savedOpts.gemini_api_key).toBe("AIzaSecretKey");
    expect(savedOpts.message_buffer_seconds).toBe(8);
    expect(json.agent.options.google_tokens).toBeUndefined();
    expect(json.agent.options.google_connected).toBe(true);
  });

  it("PATCH calendar preserva owner_summary_model para não-admin e mantém google_credentials quando omitido", async () => {
    const req = new NextRequest("http://localhost/api/agent/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: 10,
        section: "calendar",
        is_scheduler: true,
        options: {
          calendar_enabled: true,
          calendar_default_duration: 45,
        },
        scheduler_config: {
          owner_summary_enabled: true,
          owner_summary_model: "openai/gpt-4.1",
        },
      }),
    });

    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const savedOpts = state.updatedPayloads[0].options as Record<string, unknown>;
    const savedSched = state.updatedPayloads[0].scheduler_config as Record<string, unknown>;
    expect(savedOpts.google_credentials).toBe('{"web":{"client_secret":"top-secret"}}');
    expect(savedSched.owner_summary_model).toBe("google/gemini-2.5-flash-lite");
  });

  it("PATCH admin real pode alterar target_model", async () => {
    state.auth.isAdmin = true;
    const req = new NextRequest("http://localhost/api/agent/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: 10,
        section: "identity",
        name: "Vendedor A",
        role: "SDR",
        personality: "Direto",
        tone: "Consultivo",
        target_model: "google/gemini-2.5-pro",
        options: {},
      }),
    });

    const res = await PATCH(req);
    expect(res.status).toBe(200);
    expect(state.updatedPayloads[0].target_model).toBe("google/gemini-2.5-pro");
  });

  it("PATCH identity permite admin definir options.fallback_model e bloqueia não-admin", async () => {
    state.auth.isAdmin = false;
    const nonAdminReq = new NextRequest("http://localhost/api/agent/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: 10,
        section: "identity",
        name: "Vendedor A",
        options: { fallback_model: "openrouter:openai/gpt-4o" },
      }),
    });
    const res1 = await PATCH(nonAdminReq);
    expect(res1.status).toBe(200);
    expect((state.updatedPayloads[0].options as Record<string, unknown>).fallback_model).toBe("");

    state.updatedPayloads = [];
    state.auth.isAdmin = true;
    const adminReq = new NextRequest("http://localhost/api/agent/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: 10,
        section: "identity",
        name: "Vendedor A",
        options: { fallback_model: "openrouter:openai/gpt-4o-mini" },
      }),
    });
    const res2 = await PATCH(adminReq);
    expect(res2.status).toBe(200);
    expect((state.updatedPayloads[0].options as Record<string, unknown>).fallback_model).toBe("openrouter:openai/gpt-4o-mini");
  });

  it("PATCH follow_up atualiza options.follow_up preservando segredos existentes", async () => {
    const req = new NextRequest("http://localhost/api/agent/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: 10,
        section: "follow_up",
        follow_up: {
          enabled: true,
          follow_up_1h_enabled: true,
          follow_up_1h_delay_minutes: 45,
        },
      }),
    });

    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    const savedOpts = state.updatedPayloads[0].options as Record<string, unknown>;
    expect(savedOpts.follow_up).toEqual({
      enabled: true,
      follow_up_1h_enabled: true,
      follow_up_1h_delay_minutes: 45,
    });
    expect(savedOpts.google_tokens).toEqual({ access_token: "ya29.secret", refresh_token: "1//secret-refresh" });
    expect(json.agent.options.google_tokens).toBeUndefined();
    expect(json.agent.options.follow_up).toEqual({
      enabled: true,
      follow_up_1h_enabled: true,
      follow_up_1h_delay_minutes: 45,
    });
  });

  it("isola cross-tenant (404 em agente alheio, 403 em instância alheia, 409 em conflito interno, 400 ao deletar último agente)", async () => {
    const patchOther = await PATCH(
      new NextRequest("http://localhost/api/agent/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: 20, section: "prompt", main_prompt: "hack" }),
      }),
    );
    expect(patchOther.status).toBe(404);

    const bindForeign = await POST(
      new NextRequest("http://localhost/api/agent/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bind_instance", agent_id: 10, instance_name: "inst-b" }),
      }),
    );
    expect(bindForeign.status).toBe(403);

    const bindConflict = await POST(
      new NextRequest("http://localhost/api/agent/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bind_instance", agent_id: 10, instance_name: "inst-a-other" }),
      }),
    );
    expect(bindConflict.status).toBe(409);

    const delLast = await DELETE(
      new NextRequest("http://localhost/api/agent/settings?agent_id=10", { method: "DELETE" }),
    );
    expect(delLast.status).toBe(400);
  });

  it("agent-config-cache reutiliza bundle dentro de 20s, invalida em escrita e expira após TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T10:00:00Z"));

    const first = await getCachedAgentStaticBundle({
      agentId: 10,
      clientId: "tenant-a",
      forceCacheInTests: true,
    });
    expect(first.agentConfig?.name).toBe("Vendedor A");
    expect(first.hasCatalogOrPhotoKb).toBe(true);
    expect(state.agentSettingsQueries).toBe(1);

    const second = await getCachedAgentStaticBundle({
      agentId: 10,
      clientId: "tenant-a",
      forceCacheInTests: true,
    });
    expect(second.agentConfig?.name).toBe("Vendedor A");
    expect(state.agentSettingsQueries).toBe(1);

    invalidateAgentConfigCache(10);
    await getCachedAgentStaticBundle({
      agentId: 10,
      clientId: "tenant-a",
      forceCacheInTests: true,
    });
    expect(state.agentSettingsQueries).toBe(2);

    vi.advanceTimersByTime(20_001);
    await getCachedAgentStaticBundle({
      agentId: 10,
      clientId: "tenant-a",
      forceCacheInTests: true,
    });
    expect(state.agentSettingsQueries).toBe(3);
  });
});

