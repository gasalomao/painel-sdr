// @vitest-environment node
import http from "node:http";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MMZAP_GOVERNOR_SETTINGS, type WarmupConfig } from "../warmup-types";

type TableName =
  | "whatsapp_warmup_configs"
  | "contacts"
  | "campaign_targets"
  | "warmup_external_quarantine"
  | "app_settings"
  | "whatsapp_phone_passports"
  | "clients"
  | "proxy_pool"
  | "whatsapp_warmup_logs";

const state: Record<TableName, Array<Record<string, unknown>>> = {
  whatsapp_warmup_configs: [],
  contacts: [],
  campaign_targets: [],
  warmup_external_quarantine: [],
  app_settings: [],
  whatsapp_phone_passports: [],
  clients: [],
  proxy_pool: [],
  whatsapp_warmup_logs: [],
};

const authMock = {
  ok: true as const,
  clientId: "admin-1",
  isAdmin: true,
  impersonating: false,
  response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
};

vi.mock("@/lib/tenant", () => ({
  requireClientId: vi.fn(async () => authMock),
}));

vi.mock("@/lib/warmup/warmup-pending-actions", () => ({
  enqueuePendingWarmupAction: vi.fn(async () => {}),
}));

vi.mock("@/lib/manual-send-registry", () => ({
  isAiSend: vi.fn((id: string) => id.startsWith("ai-")),
  isWarmupSend: vi.fn((id: string) => id.startsWith("wu-")),
  isManualSend: vi.fn((id: string) => id.startsWith("man-")),
  isPendingAutomatedSend: vi.fn(() => false),
}));

vi.mock("@/lib/proxy-pool", () => ({
  ensureProxyForInstance: vi.fn(async () => ({ ok: true, mode: "pool_assigned", usedVpsFallback: false })),
  getProxyPoolOverviewCache: vi.fn(async () => ({ hasPool: false, brHosts: [] })),
}));

vi.mock("@/lib/supabase_admin", () => {
  function applyFilters(
    rows: Array<Record<string, unknown>>,
    filters: Array<(r: Record<string, unknown>) => boolean>
  ) {
    return rows.filter((r) => filters.every((fn) => fn(r)));
  }

  function makeBuilder(table: TableName) {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let pendingOp: "select" | "insert" | "upsert" | "update" = "select";
    let payload: Record<string, unknown> | Array<Record<string, unknown>> | null = null;
    let onConflictCols: string[] = [];
    let limitNum: number | null = null;

    const execute = async () => {
      if (!state[table]) state[table] = [];
      if (pendingOp === "insert" && payload) {
        const items = Array.isArray(payload) ? payload : [payload];
        for (const item of items) {
          state[table].push({
            id: (item.id as string) || `${table}-${state[table].length + 1}`,
            ...item,
          });
        }
        return { data: items, error: null };
      }

      if (pendingOp === "upsert" && payload) {
        const items = Array.isArray(payload) ? payload : [payload];
        for (const item of items) {
          const existingIdx = state[table].findIndex(
            (r) => onConflictCols.length > 0 && onConflictCols.every((c) => r[c] === item[c])
          );
          if (existingIdx >= 0) {
            state[table][existingIdx] = { ...state[table][existingIdx], ...item };
          } else {
            state[table].push({
              id: (item.id as string) || `${table}-${state[table].length + 1}`,
              ...item,
            });
          }
        }
        return { data: items, error: null };
      }

      if (pendingOp === "update" && payload && !Array.isArray(payload)) {
        const matches = applyFilters(state[table], filters);
        for (const row of matches) {
          Object.assign(row, payload);
        }
        return { data: matches, error: null };
      }

      let rows = applyFilters(state[table], filters);
      if (limitNum !== null) rows = rows.slice(0, limitNum);
      return { data: rows, error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (data: Record<string, unknown>) => {
        pendingOp = "insert";
        payload = data;
        return builder;
      },
      upsert: (data: Record<string, unknown>, opts?: { onConflict?: string }) => {
        pendingOp = "upsert";
        payload = data;
        onConflictCols = String(opts?.onConflict || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        return builder;
      },
      update: (data: Record<string, unknown>) => {
        pendingOp = "update";
        payload = data;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return builder;
      },
      order: () => builder,
      limit: (n: number) => {
        limitNum = n;
        return builder;
      },
      maybeSingle: async () => {
        const res = await execute();
        return { data: res.data[0] || null, error: null };
      },
      then: (
        resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown,
        reject?: (err: unknown) => unknown
      ) => execute().then(resolve, reject),
    };

    return builder;
  }

  return {
    supabaseAdmin: {
      from: (table: TableName) => makeBuilder(table),
    },
  };
});

import {
  checkExternalWarmupInbound,
  evaluateMmzapShiftGovernor,
  invalidateExternalShieldCache,
} from "../warmup-external-shield";
import {
  selectNextMmzapShiftCandidate,
  tickMmzapBrowserOrchestrator,
} from "../mmzap-browser-orchestrator";
import { GET as getMmzapBrowserRoute, POST as postMmzapBrowserRoute } from "@/app/api/warmup/mmzap-browser/route";
import { NextRequest } from "next/server";

function makeChipConfig(overrides: Partial<WarmupConfig> = {}): WarmupConfig {
  return {
    client_id: "admin-1",
    instance_name: "chip-01",
    phone_number: "5573991810230",
    enabled: true,
    stage: 1,
    stage_auto_progress: true,
    days_active: 3,
    consecutive_successful_days: 2,
    health_score: 98,
    is_quarantined: false,
    daily_target: 20,
    sent_today: 0,
    received_today: 0,
    error_count_today: 0,
    min_interval_seconds: 120,
    max_interval_seconds: 300,
    min_typing_seconds: 3,
    max_typing_seconds: 7,
    allowed_start_hour: 8,
    allowed_end_hour: 21,
    ai_model: "auto:free",
    ai_theme: "dia_a_dia",
    enable_typing: true,
    enable_blue_ticks: true,
    enable_reactions: true,
    enable_audio: true,
    enable_vcard: true,
    enable_status_posts: true,
    continuous_warmup: true,
    purpose: "outbound",
    career_mode: "maturing",
    external_warmup_mode: "receive_only",
    external_warmup_inbound_today: 0,
    external_warmup_inbound_total: 0,
    external_mmzap_sent_today: 0,
    external_mmzap_sent_total: 0,
    mmzap_browser_enabled: true,
    mmzap_browser_status: "idle",
    mmzap_minutes_today: 0,
    mmzap_shifts_today: 0,
    created_at: new Date(Date.now() - 48 * 3600_000).toISOString(),
    ...overrides,
  };
}

// Hora fixa 14:00 BRT (17:00 UTC) dentro da janela 08..21 BRT
const NOON_BRT_MS = new Date("2026-11-26T17:00:00.000Z").getTime();
// Hora fixa 23:00 BRT (02:00 UTC) fora da janela 08..21 BRT
const NIGHT_BRT_MS = new Date("2026-11-27T02:00:00.000Z").getTime();

describe("MMZap Browser Governor & Orchestrator", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    for (const k of Object.keys(state) as TableName[]) {
      state[k] = [];
    }
    state.clients.push({ id: "admin-1", is_admin: true, is_active: true });
    authMock.isAdmin = true;
    authMock.impersonating = false;
    invalidateExternalShieldCache();
    delete process.env.MMZAP_WORKER_URL;
    delete process.env.MMZAP_WORKER_SECRET;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("aplica todos os cortes do governador por fase, meta inbound, freio, janela e orçamento unificado", () => {
    const settings = { ...DEFAULT_MMZAP_GOVERNOR_SETTINGS };

    expect(
      evaluateMmzapShiftGovernor({
        stage: 1,
        mmzapSentToday: 2,
        mmzapInboundToday: 8,
        internalSentToday: 4,
        dailyTarget: 20,
        governorSettings: settings,
        nowMs: NOON_BRT_MS,
      })
    ).toEqual({ shouldStop: false, maxSendsCap: 4 });

    expect(
      evaluateMmzapShiftGovernor({
        stage: 1,
        mmzapSentToday: 4,
        mmzapInboundToday: 12,
        internalSentToday: 0,
        dailyTarget: 20,
        governorSettings: settings,
        nowMs: NOON_BRT_MS,
      }).reason
    ).toBe("max_sends_reached");

    expect(
      evaluateMmzapShiftGovernor({
        stage: 2,
        mmzapSentToday: 3,
        mmzapInboundToday: 0,
        internalSentToday: 0,
        dailyTarget: 40,
        governorSettings: settings,
        nowMs: NOON_BRT_MS,
      }).reason
    ).toBe("unanswered_brake");

    expect(
      evaluateMmzapShiftGovernor({
        stage: 2,
        mmzapSentToday: 2,
        mmzapInboundToday: 15,
        internalSentToday: 0,
        dailyTarget: 40,
        governorSettings: settings,
        nowMs: NOON_BRT_MS,
      }).reason
    ).toBe("inbound_target_reached");

    expect(
      evaluateMmzapShiftGovernor({
        stage: 2,
        mmzapSentToday: 3,
        mmzapInboundToday: 5,
        internalSentToday: 37,
        dailyTarget: 40,
        governorSettings: settings,
        nowMs: NOON_BRT_MS,
      }).reason
    ).toBe("daily_budget_reached");

    expect(
      evaluateMmzapShiftGovernor({
        stage: 1,
        mmzapSentToday: 1,
        mmzapInboundToday: 1,
        internalSentToday: 0,
        dailyTarget: 20,
        mmzapShiftStartedAt: new Date(NOON_BRT_MS - 46 * 60_000).toISOString(),
        governorSettings: settings,
        nowMs: NOON_BRT_MS,
      }).reason
    ).toBe("shift_timeout");

    expect(
      evaluateMmzapShiftGovernor({
        stage: 4,
        mmzapSentToday: 0,
        mmzapInboundToday: 0,
        internalSentToday: 0,
        dailyTarget: 70,
        governorSettings: settings,
        nowMs: NOON_BRT_MS,
      }).reason
    ).toBe("auto_disabled_stage");

    expect(
      evaluateMmzapShiftGovernor({
        stage: 4,
        mmzapSentToday: 5,
        mmzapInboundToday: 5,
        internalSentToday: 0,
        dailyTarget: 70,
        mmzapMaxSendsOverride: 15,
        governorSettings: settings,
        nowMs: NOON_BRT_MS,
      }).shouldStop
    ).toBe(false);

    expect(
      evaluateMmzapShiftGovernor({
        stage: 1,
        mmzapSentToday: 0,
        mmzapInboundToday: 0,
        internalSentToday: 0,
        dailyTarget: 20,
        governorSettings: settings,
        nowMs: NIGHT_BRT_MS,
      }).reason
    ).toBe("outside_window");
  });

  it("self_echo incrementa external_mmzap_sent_today e dispara kill-switch em tempo real ao atingir teto", async () => {
    process.env.MMZAP_WORKER_URL = "http://worker.internal:3099";
    process.env.MMZAP_WORKER_SECRET = "secret-test";

    const stopCalls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      stopCalls.push(target);
      return new Response(JSON.stringify({ instanceName: "chip-kill", status: "idle" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    state.whatsapp_warmup_configs.push({
      client_id: "admin-1",
      instance_name: "chip-kill",
      phone_number: "5573991810230",
      stage: 1,
      daily_target: 20,
      sent_today: 0,
      received_today: 5,
      external_warmup_mode: "receive_only",
      enable_blue_ticks: true,
      external_warmup_inbound_today: 8,
      external_warmup_inbound_total: 8,
      external_mmzap_sent_today: 3,
      external_mmzap_sent_total: 20,
      mmzap_browser_status: "running",
      mmzap_shift_started_at: new Date(NOON_BRT_MS - 10 * 60_000).toISOString(),
    });

    const res = await checkExternalWarmupInbound({
      clientId: "admin-1",
      instanceName: "chip-kill",
      remoteJid: "5511977776666@s.whatsapp.net",
      messageId: "ext-msg-1",
      messageText: "Boa tarde!",
      fromMe: true,
      nowMs: NOON_BRT_MS,
    });

    expect(res.blocked).toBe(true);
    expect(res.classification).toBe("self_echo");

    const row = state.whatsapp_warmup_configs[0];
    expect(row.external_mmzap_sent_today).toBe(4);
    expect(row.external_mmzap_sent_total).toBe(21);
    expect(row.mmzap_browser_status).toBe("idle");
    expect(stopCalls.some((u) => u.includes("/sessions/chip-kill/stop"))).toBe(true);
  });

  it("seleciona candidato justo respeitando Day0, descanso e limite de sessões na RAM", async () => {
    const chipDay0 = makeChipConfig({
      instance_name: "chip-day0",
      days_active: 1,
      created_at: new Date(NOON_BRT_MS - 2 * 3600_000).toISOString(),
    });
    const chipResting = makeChipConfig({
      instance_name: "chip-resting",
      mmzap_last_shift_ended_at: new Date(NOON_BRT_MS - 20 * 60_000).toISOString(),
    });
    const chipBusyEarlier = makeChipConfig({
      instance_name: "chip-a",
      mmzap_shifts_today: 1,
      external_warmup_inbound_today: 5,
    });
    const chipFairFirst = makeChipConfig({
      instance_name: "chip-b",
      mmzap_shifts_today: 0,
      external_warmup_inbound_today: 1,
    });

    const picked = selectNextMmzapShiftCandidate({
      configs: [chipDay0, chipResting, chipBusyEarlier, chipFairFirst],
      governor: { ...DEFAULT_MMZAP_GOVERNOR_SETTINGS },
      nowMs: NOON_BRT_MS,
    });
    expect(picked?.instance_name).toBe("chip-b");

    // Teste de orquestração completa com rotação de proxy derrubando sessão desatualizada
    process.env.MMZAP_WORKER_URL = "http://worker.internal:3099";
    state.whatsapp_warmup_configs.push(
      makeChipConfig({
        instance_name: "chip-rotated",
        mmzap_browser_status: "running",
        mmzap_proxy_endpoint: "1.1.1.1",
        mmzap_shift_started_at: new Date(NOON_BRT_MS - 5 * 60_000).toISOString(),
      }),
      makeChipConfig({
        instance_name: "chip-ready",
        mmzap_browser_status: "idle",
      })
    );
    state.proxy_pool.push(
      {
        host: "9.9.9.9",
        port: 6172,
        protocol: "http",
        username: "u1",
        password: "p1",
        assigned_instance: "chip-rotated",
        status: "assigned",
      },
      {
        host: "8.8.8.8",
        port: 6172,
        protocol: "http",
        username: "u2",
        password: "p2",
        assigned_instance: "chip-ready",
        status: "assigned",
      }
    );

    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/health")) {
        return new Response(
          JSON.stringify({
            ok: true,
            activeSessions: 1,
            maxConcurrent: 2,
            sessions: [{ instanceName: "chip-rotated", status: "running", proxyIp: "1.1.1.1" }],
          }),
          { status: 200 }
        );
      }
      if (u.includes("/stop")) {
        return new Response(JSON.stringify({ instanceName: "chip-rotated", status: "idle" }), { status: 200 });
      }
      if (u.includes("/start")) {
        return new Response(
          JSON.stringify({ instanceName: "chip-ready", status: "running", proxyIp: "8.8.8.8" }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const orch = await tickMmzapBrowserOrchestrator({
      clientId: "admin-1",
      configs: state.whatsapp_warmup_configs as unknown as WarmupConfig[],
      connectedInstanceNames: new Set(["chip-rotated", "chip-ready"]),
      nowMs: NOON_BRT_MS,
    });

    expect(orch.stopped).toContain("chip-rotated");
    expect(orch.started).toContain("chip-ready");
    expect(calls.some((u) => u.includes("/sessions/chip-rotated/stop"))).toBe(true);
    expect(calls.some((u) => u.includes("/sessions/chip-ready/start"))).toBe(true);
  });

  it("bloqueia /api/warmup/mmzap-browser para não-admin e para admin personificando cliente", async () => {
    authMock.isAdmin = false;
    const reqNonAdmin = new NextRequest("http://localhost/api/warmup/mmzap-browser", {
      method: "GET",
    });
    const res1 = await getMmzapBrowserRoute(reqNonAdmin);
    expect(res1.status).toBe(403);

    authMock.isAdmin = true;
    authMock.impersonating = true;
    const reqImp = new NextRequest("http://localhost/api/warmup/mmzap-browser", {
      method: "POST",
      body: JSON.stringify({ action: "save_governor", max_concurrent_browsers: 2 }),
    });
    const res2 = await postMmzapBrowserRoute(reqImp);
    expect(res2.status).toBe(403);

    authMock.impersonating = false;
    const resOk = await getMmzapBrowserRoute(
      new NextRequest("http://localhost/api/warmup/mmzap-browser", { method: "GET" })
    );
    expect(resOk.status).toBe(200);
    const body = (await resOk.json()) as { success: boolean; data: { configured: boolean } };
    expect(body.success).toBe(true);
    expect(body.data.configured).toBe(false);
  });

  it("release_quarantine libera chip em quarentena e GET ?action=qr ativa turno automático após parear", async () => {
    process.env.MMZAP_WORKER_URL = "http://worker.internal:3099";
    process.env.MMZAP_WORKER_SECRET = "secret-test";

    state.whatsapp_warmup_configs.push(
      makeChipConfig({
        instance_name: "00000_DD_11",
        is_quarantined: true,
        quarantine_reason: "Desconexão 428",
        health_score: 0,
        external_warmup_mode: "off",
        mmzap_browser_enabled: false,
        mmzap_browser_status: "qr_pending",
        mmzap_shifts_today: 0,
      })
    );

    const relRes = await postMmzapBrowserRoute(
      new NextRequest("http://localhost/api/warmup/mmzap-browser", {
        method: "POST",
        body: JSON.stringify({ action: "release_quarantine", instance_name: "00000_DD_11" }),
      })
    );
    expect(relRes.status).toBe(200);
    const chipRow = state.whatsapp_warmup_configs[0];
    expect(chipRow.is_quarantined).toBe(false);
    expect(chipRow.health_score).toBe(65);

    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          instanceName: "00000_DD_11",
          status: "running",
          mmzapUiDetected: true,
          mmzapChipState: "is-on",
          mmzapStatusLabel: "Ativo",
          proxyIp: "185.72.242.164",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    ) as unknown as typeof fetch;

    const qrRes = await getMmzapBrowserRoute(
      new NextRequest(
        "http://localhost/api/warmup/mmzap-browser?action=qr&instance=00000_DD_11",
        { method: "GET" }
      )
    );
    expect(qrRes.status).toBe(200);
    expect(chipRow.mmzap_browser_status).toBe("running");
    expect(chipRow.mmzap_browser_enabled).toBe(true);
    expect(chipRow.external_warmup_mode).toBe("receive_only");
    expect(chipRow.mmzap_shifts_today).toBe(1);

    authMock.isAdmin = false;
    const deniedRes = await postMmzapBrowserRoute(
      new NextRequest("http://localhost/api/warmup/mmzap-browser", {
        method: "POST",
        body: JSON.stringify({ action: "release_quarantine", instance_name: "00000_DD_11" }),
      })
    );
    expect(deniedRes.status).toBe(403);
  });

  it("proxy-tunnel.mjs injeta Proxy-Authorization Basic em HTTP GET e CONNECT sobre socket TCP real", async () => {
    const mod = await import("../../../../services/mmzap-browser-worker/src/proxy-tunnel.mjs");
    const createAuthenticatedProxyTunnel = mod.createAuthenticatedProxyTunnel as (cfg: {
      server: string;
      username?: string;
      password?: string;
    }) => Promise<{ localPort: number; close: () => Promise<void> } | null>;

    const receivedProxyAuths: string[] = [];
    const mockSockets = new Set<net.Socket>();

    // Mock servidor proxy upstream que valida Basic auth tanto no GET quanto no CONNECT
    const upstreamProxy = http.createServer((req, res) => {
      receivedProxyAuths.push(String(req.headers["proxy-authorization"] || ""));
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("http-proxy-ok");
    });

    upstreamProxy.on("connect", (req, clientSocket) => {
      mockSockets.add(clientSocket);
      clientSocket.on("close", () => mockSockets.delete(clientSocket));
      receivedProxyAuths.push(String(req.headers["proxy-authorization"] || ""));
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      clientSocket.on("data", (chunk) => {
        // Eco simples dentro do túnel CONNECT para provar tráfego bidirecional
        clientSocket.write(`echo:${chunk.toString("utf8")}`);
      });
    });

    await new Promise<void>((resolve) => upstreamProxy.listen(0, "127.0.0.1", () => resolve()));
    const upstreamAddr = upstreamProxy.address() as net.AddressInfo;

    const tunnel = await createAuthenticatedProxyTunnel({
      server: `http://127.0.0.1:${upstreamAddr.port}`,
      username: "user_br",
      password: "secret_pw",
    });
    expect(tunnel).not.toBeNull();

    try {
      // 1. Testa plain HTTP via túnel
      const httpBody = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: tunnel!.localPort,
            method: "GET",
            path: "http://example.com/check",
            agent: false,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          }
        );
        req.on("error", reject);
        req.end();
      });
      expect(httpBody).toBe("http-proxy-ok");

      // 2. Testa HTTP CONNECT via socket TCP puro
      const tunnelReply = await new Promise<string>((resolve, reject) => {
        const sock = net.connect(tunnel!.localPort, "127.0.0.1", () => {
          sock.write("CONNECT web.whatsapp.com:443 HTTP/1.1\r\nHost: web.whatsapp.com:443\r\n\r\n");
        });
        let stage = 0;
        let buf = "";
        sock.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          if (stage === 0 && buf.includes("\r\n\r\n")) {
            stage = 1;
            buf = "";
            sock.write("ping-wa");
          } else if (stage === 1 && buf.includes("echo:ping-wa")) {
            sock.destroy();
            resolve(buf);
          }
        });
        sock.on("error", reject);
      });
      expect(tunnelReply).toBe("echo:ping-wa");

      const expectedHeader = `Basic ${Buffer.from("user_br:secret_pw").toString("base64")}`;
      expect(receivedProxyAuths).toEqual([expectedHeader, expectedHeader]);
    } finally {
      await tunnel!.close();
      for (const s of mockSockets) {
        s.destroy();
      }
      upstreamProxy.closeAllConnections?.();
      await new Promise<void>((resolve) => upstreamProxy.close(() => resolve()));
    }
  });
});
