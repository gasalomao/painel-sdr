// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  from: vi.fn(),
  fetchInstances: vi.fn(),
  ensure: vi.fn(),
  readConfigs: vi.fn(),
  readConnections: vi.fn(),
  getGlobal: vi.fn(),
  saveGlobal: vi.fn(),
  saveConfig: vi.fn(),
  setEnabled: vi.fn(),
}));

vi.mock("@/lib/tenant", () => ({ requireClientId: mocks.auth }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("@/lib/evolution", () => ({ evolution: { fetchInstances: mocks.fetchInstances } }));
vi.mock("@/lib/warmup/warmup-config-service", () => ({
  ensureWarmupConfigsForTenant: mocks.ensure,
  readTenantWarmupConfigs: mocks.readConfigs,
  readTenantConnections: mocks.readConnections,
  getGlobalWarmupSettings: mocks.getGlobal,
  saveGlobalWarmupSettings: mocks.saveGlobal,
  saveWarmupConfig: mocks.saveConfig,
  setWarmupEnabledForAll: mocks.setEnabled,
  isConnectedStatus: (status: string) =>
    ["open", "connected"].includes(String(status || "").toLowerCase()),
}));

import { GET, POST, PUT } from "./route";

function request(method: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/warmup", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.auth.mockResolvedValue({ ok: true, clientId: "tenant-1", isAdmin: false, impersonating: false });
  mocks.from.mockReset();
  mocks.fetchInstances.mockReset().mockResolvedValue({ instances: [] });
  mocks.ensure.mockReset().mockResolvedValue({
    created: [],
    enabledNew: [],
    source: "table",
    connections: [],
  });
  mocks.readConfigs.mockReset().mockResolvedValue({ source: "table", configs: {} });
  mocks.readConnections.mockReset().mockResolvedValue([]);
  mocks.getGlobal.mockReset().mockResolvedValue({ stage_auto_progress: true, auto_warmup_new_chips: true });
  mocks.saveGlobal.mockReset().mockImplementation(async (_client, settings) => settings);
  mocks.saveConfig.mockReset().mockResolvedValue({
    ok: true,
    config: { client_id: "tenant-1", instance_name: "chip-1" },
  });
  mocks.setEnabled.mockReset().mockResolvedValue({ updated: 2, source: "table" });
});

describe("GET /api/warmup", () => {
  it("lista chips do tenant e marca instância órfã da Evolution", async () => {
    mocks.ensure.mockResolvedValue({
      created: [],
      enabledNew: [],
      source: "table",
      connections: [{ instance_name: "chip-1", status: "open", phone_number: null }],
    });
    mocks.readConfigs.mockResolvedValue({
      source: "table",
      configs: {
        "chip-1": {
          client_id: "tenant-1",
          instance_name: "chip-1",
          enabled: true,
          stage: 1,
          daily_target: 10,
          sent_today: 3,
          received_today: 2,
        },
      },
    });
    mocks.fetchInstances.mockResolvedValue({
      instances: [
        { instance: { instanceName: "chip-1", owner: "5511999990000@s.whatsapp.net" } },
        { instance: { instanceName: "orfao-1" } },
      ],
    });
    mocks.from.mockImplementation(() => {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: async () => ({ data: [], error: null }),
        then: (resolve: any, reject: any) =>
          Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject),
      };
      return builder;
    });

    const response = await GET(new NextRequest("http://localhost/api/warmup"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.instances.map((item: any) => item.instance_name)).toEqual(["chip-1", "orfao-1"]);
    expect(body.data.instances[1].orphan).toBe(true);
    expect(body.data.stats).toMatchObject({
      totalChips: 1,
      activeWarmup: 1,
      orphanChips: 1,
      totalSentToday: 3,
    });
  });
});

describe("PUT /api/warmup", () => {
  it("salva configuração do chip usando o client_id da sessão", async () => {
    const response = await PUT(request("PUT", { instance_name: "chip-1", stage: 2, enabled: true }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mocks.saveConfig).toHaveBeenCalledWith("tenant-1", "chip-1", { stage: 2, enabled: true });
  });

  it("rejeita corpo sem instance_name", async () => {
    const response = await PUT(request("PUT", { stage: 2 }));

    expect(response.status).toBe(400);
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it("encaminha erro de autenticação sem salvar", async () => {
    const unauthorized = NextResponse.json({ error: "Não autenticado" }, { status: 401 });
    mocks.auth.mockResolvedValue({ ok: false, response: unauthorized });

    const response = await PUT(request("PUT", { instance_name: "chip-1" }));

    expect(response).toBe(unauthorized);
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });
});

describe("POST /api/warmup", () => {
  it("ativa todos os chips incluindo recém-conectados", async () => {
    const response = await POST(request("POST", { action: "enable_all" }));
    const body = await response.json();

    expect(body).toMatchObject({ success: true, enabled: true, updated: 2 });
    expect(mocks.setEnabled).toHaveBeenCalledWith("tenant-1", true);
  });

  it("salva ajustes globais com opção de aplicar aos chips existentes", async () => {
    const response = await POST(
      request("POST", {
        type: "global_settings",
        applyToAll: true,
        enable_audio: false,
        auto_warmup_new_chips: true,
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.saveGlobal).toHaveBeenCalledWith(
      "tenant-1",
      expect.objectContaining({ enable_audio: false, auto_warmup_new_chips: true }),
      true
    );
  });
});
