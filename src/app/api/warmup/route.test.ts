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
  reaudit: vi.fn(),
}));

vi.mock("@/lib/tenant", () => ({ requireClientId: mocks.auth }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("@/lib/evolution", () => ({ evolution: { fetchInstances: mocks.fetchInstances } }));
vi.mock("@/lib/warmup/warmup-groups", async () => {
  const actual = await vi.importActual<typeof import("@/lib/warmup/warmup-groups")>("@/lib/warmup/warmup-groups");
  return {
    ...actual,
    auditChipDay0Hygiene: mocks.reaudit,
  };
});
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
  mocks.auth.mockResolvedValue({
    ok: true,
    clientId: "tenant-1",
    isAdmin: false,
    impersonating: false,
    claims: { features: { aquecer_chips: true } },
  });
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
  mocks.reaudit.mockReset().mockResolvedValue({ ok: true, warnings: [] });
});

describe("GET /api/warmup", () => {
  it("bloqueia com 403 quando módulo aquecer_chips não está liberado para o tenant", async () => {
    mocks.auth.mockResolvedValueOnce({
      ok: true,
      clientId: "tenant-1",
      isAdmin: false,
      impersonating: false,
      claims: { features: { aquecer_chips: false } },
    });
    const res = await GET(new NextRequest("http://localhost/api/warmup"));
    expect(res.status).toBe(403);
  });

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

  it("expõe alertas da Auditoria Dia-0 e taxa de entrega/leitura/resposta em cada chip", async () => {
    mocks.ensure.mockResolvedValue({
      created: [],
      enabledNew: [],
      source: "table",
      connections: [{ instance_name: "chip-1", status: "open", phone_number: "5511999990000" }],
    });
    mocks.readConfigs.mockResolvedValue({
      source: "table",
      configs: {
        "chip-1": { client_id: "tenant-1", instance_name: "chip-1", enabled: true, stage: 2 },
      },
    });
    mocks.from.mockImplementation((table: string) => {
      const rows =
        table === "whatsapp_warmup_logs"
          ? [
              {
                sender_instance: "chip-1",
                receiver_instance: "day0_hygiene",
                message_text: "⚠️ Auditoria Dia-0 (chip-1): chip sem foto de perfil configurada | proxy estrangeiro (US).",
                action_type: "system",
              },
            ]
          : table === "chats_dashboard"
            ? [
                { instance_name: "chip-1", sender_type: "ai", status_envio: "read" },
                { instance_name: "chip-1", sender_type: "ai", status_envio: "delivered" },
                { instance_name: "chip-1", sender_type: "customer", status_envio: "received" },
              ]
            : [];
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: async () => ({ data: rows, error: null }),
        then: (resolve: any, reject: any) =>
          Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject),
      };
      return builder;
    });

    const response = await GET(new NextRequest("http://localhost/api/warmup"));
    const body = await response.json();
    const chip = body.data.instances[0];

    expect(response.status).toBe(200);
    expect(chip.day0_warnings).toEqual([
      "chip sem foto de perfil configurada",
      "proxy estrangeiro (US)",
    ]);
    expect(chip.day0_status).toBe("warning");
    expect(chip.metrics).toEqual({
      outbound: 2,
      deliveredRate: 100,
      readRate: 50,
      replyRate: 50,
      failed: 0,
    });
  });

  it("expõe day0_status ok após Auditoria Dia-0 OK e pending para chips sem histórico", async () => {
    mocks.ensure.mockResolvedValue({
      created: [],
      enabledNew: [],
      source: "table",
      connections: [
        { instance_name: "chip-ok", status: "open", phone_number: "5511999990001" },
        { instance_name: "chip-antigo", status: "open", phone_number: "5511999990002" },
      ],
    });
    mocks.readConfigs.mockResolvedValue({
      source: "table",
      configs: {
        "chip-ok": { client_id: "tenant-1", instance_name: "chip-ok", enabled: true, stage: 2 },
        "chip-antigo": { client_id: "tenant-1", instance_name: "chip-antigo", enabled: true, stage: 3 },
      },
    });
    mocks.from.mockImplementation((table: string) => {
      const rows =
        table === "whatsapp_warmup_logs"
          ? [
              {
                sender_instance: "chip-ok",
                receiver_instance: "day0_hygiene",
                message_text: "✓ Auditoria Dia-0 OK (chip-ok): foto de perfil e proxy validados.",
                action_type: "system",
              },
            ]
          : [];
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: async () => ({ data: rows, error: null }),
        then: (resolve: any, reject: any) =>
          Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject),
      };
      return builder;
    });

    const response = await GET(new NextRequest("http://localhost/api/warmup"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.instances[0]).toMatchObject({ instance_name: "chip-ok", day0_status: "ok", day0_warnings: [] });
    expect(body.data.instances[1]).toMatchObject({ instance_name: "chip-antigo", day0_status: "pending", day0_warnings: [] });
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

  it("reaudita Dia-0 para instância do tenant e bloqueia instância de outro tenant", async () => {
    mocks.readConnections.mockResolvedValue([{ instance_name: "chip-1", status: "open", phone_number: "5511999990000" }]);
    const okRes = await POST(request("POST", { action: "reaudit_day0", instance_name: "chip-1" }));
    const okBody = await okRes.json();

    expect(okRes.status).toBe(200);
    expect(okBody).toEqual({ success: true, ok: true, warnings: [] });
    expect(mocks.reaudit).toHaveBeenCalledWith("tenant-1", "chip-1", { forceInTests: true });

    const forbiddenRes = await POST(request("POST", { action: "reaudit_day0", instance_name: "chip-outro" }));
    expect(forbiddenRes.status).toBe(403);
  });
});
