// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const launchPersistentContextMock = vi.fn();

vi.mock("playwright", () => ({
  chromium: {
    launchPersistentContext: (...args: unknown[]) => launchPersistentContextMock(...args),
  },
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: vi.fn(async () => authMock),
}));

vi.mock("@/lib/warmup/warmup-pending-actions", () => ({
  enqueuePendingWarmupAction: vi.fn(async () => {}),
}));

vi.mock("@/lib/manual-send-registry", () => ({
  isAiSend: vi.fn(() => false),
  isWarmupSend: vi.fn(() => false),
  isManualSend: vi.fn(() => false),
  isPendingAutomatedSend: vi.fn(() => false),
}));

vi.mock("@/lib/proxy-pool", () => ({
  ensureProxyForInstance: vi.fn(async () => ({
    ok: true,
    mode: "pool_assigned",
    usedVpsFallback: false,
  })),
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

import { logoutMmzapWorkerSession } from "../mmzap-browser-client";
import { invalidateExternalShieldCache } from "../warmup-external-shield";
import { POST as postMmzapBrowserRoute } from "@/app/api/warmup/mmzap-browser/route";

interface MockContextOptions {
  authenticated?: boolean;
  logoutButtonsVisible?: boolean;
  onClose?: () => void;
}

function createMockPlaywrightContext(opts: MockContextOptions = {}) {
  const { authenticated = true, logoutButtonsVisible = true, onClose } = opts;
  const clickedSelectors: string[] = [];
  let closed = false;

  const page = {
    isClosed: () => closed,
    url: () => "https://web.whatsapp.com/",
    on: vi.fn(),
    goto: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    screenshot: vi.fn(async () => Buffer.from("png-bytes")),
    close: vi.fn(async () => {
      closed = true;
    }),
    evaluate: vi.fn(async (fn: () => unknown) => {
      const src = fn.toString();
      if (src.includes("chat-list") && src.includes("landing-wrapper")) {
        return !authenticated;
      }
      if (src.includes("chat-list")) {
        return authenticated;
      }
      if (src.includes("#mmzap-chip")) {
        return authenticated
          ? { mmzapUiDetected: true, mmzapChipState: "is-on", mmzapStatusLabel: "Ativo" }
          : { mmzapUiDetected: false, mmzapChipState: null, mmzapStatusLabel: null };
      }
      return false;
    }),
    locator: vi.fn((selector: string) => ({
      first: () => ({
        isVisible: vi.fn(async () => {
          if (!logoutButtonsVisible) return false;
          return (
            selector === '[data-testid="menu"]' ||
            selector === '[data-testid="mi-logout"]' ||
            selector === '[data-testid="popup-controls-ok"]'
          );
        }),
        boundingBox: vi.fn(async () => ({ x: 0, y: 0, width: 200, height: 200 })),
        screenshot: vi.fn(async () => Buffer.from("qr-png")),
        click: vi.fn(async () => {
          clickedSelectors.push(selector);
        }),
      }),
    })),
  };

  const context = {
    route: vi.fn(async () => {}),
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    on: vi.fn(),
    browser: vi.fn(() => null),
    close: vi.fn(async () => {
      closed = true;
      onClose?.();
    }),
  };

  return { context, page, clickedSelectors };
}

describe("MMZap Logout & Auto-Wipe", () => {
  const originalFetch = globalThis.fetch;
  const originalDataDir = process.env.DATA_DIR;
  let tmpDataDir = "";

  beforeEach(async () => {
    for (const k of Object.keys(state) as TableName[]) {
      state[k] = [];
    }
    state.clients.push({ id: "admin-1", is_admin: true, is_active: true });
    authMock.clientId = "admin-1";
    authMock.isAdmin = true;
    authMock.impersonating = false;
    invalidateExternalShieldCache();
    delete process.env.MMZAP_WORKER_URL;
    delete process.env.MMZAP_WORKER_SECRET;
    launchPersistentContextMock.mockReset();

    tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mmzap-logout-test-"));
    process.env.DATA_DIR = tmpDataDir;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    if (tmpDataDir) {
      await fs.rm(tmpDataDir, { recursive: true, force: true }).catch(() => {});
      tmpDataDir = "";
    }
    vi.restoreAllMocks();
  });

  describe("logoutMmzapWorkerSession (client)", () => {
    it("chama POST /sessions/:instance/logout e retorna telemetria estruturada", async () => {
      process.env.MMZAP_WORKER_URL = "http://worker.internal:3099";
      process.env.MMZAP_WORKER_SECRET = "sec-1";

      const calls: Array<{ url: string; method: string }> = [];
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), method: String(init?.method || "GET") });
        return new Response(
          JSON.stringify({
            ok: true,
            instanceName: "chip-alpha",
            loggedOutFromWhatsApp: true,
            profileWiped: true,
            profileDirExisted: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as unknown as typeof fetch;

      const res = await logoutMmzapWorkerSession("chip-alpha");
      expect(res.ok).toBe(true);
      expect(res.data).toEqual({
        ok: true,
        instanceName: "chip-alpha",
        loggedOutFromWhatsApp: true,
        profileWiped: true,
        profileDirExisted: true,
        usedFallbackDelete: false,
      });
      expect(calls).toEqual([
        { url: "http://worker.internal:3099/sessions/chip-alpha/logout", method: "POST" },
      ]);
    });

    it("faz fallback automático para DELETE /sessions/:instance quando /logout retorna 404", async () => {
      process.env.MMZAP_WORKER_URL = "http://worker.internal:3099";

      const calls: Array<{ url: string; method: string }> = [];
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(init?.method || "GET");
        calls.push({ url: String(url), method });
        if (method === "POST") {
          return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch;

      const res = await logoutMmzapWorkerSession("chip-legacy");
      expect(res.ok).toBe(true);
      expect(res.data?.usedFallbackDelete).toBe(true);
      expect(res.data?.profileWiped).toBe(true);
      expect(calls).toEqual([
        { url: "http://worker.internal:3099/sessions/chip-legacy/logout", method: "POST" },
        { url: "http://worker.internal:3099/sessions/chip-legacy", method: "DELETE" },
      ]);
    });

    it("trata sessão ausente (404 no fallback DELETE) de forma idempotente", async () => {
      process.env.MMZAP_WORKER_URL = "http://worker.internal:3099";

      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "Not found" }), { status: 404 })) as unknown as typeof fetch;

      const res = await logoutMmzapWorkerSession("chip-absent");
      expect(res.ok).toBe(true);
      expect(res.data?.usedFallbackDelete).toBe(true);
      expect(res.data?.profileDirExisted).toBe(false);
    });
  });

  describe("POST /api/warmup/mmzap-browser action: logout & reset_profile", () => {
    it("isola multi-tenant por client_id (rejeita instância de outro tenant com 404 sem chamar worker)", async () => {
      process.env.MMZAP_WORKER_URL = "http://worker.internal:3099";
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      state.whatsapp_warmup_configs.push({
        client_id: "other-tenant",
        instance_name: "chip-foreign",
        mmzap_browser_status: "running",
        mmzap_browser_enabled: true,
        mmzap_shift_started_at: "2026-11-26T15:00:00.000Z",
        mmzap_last_error: "some_err",
        mmzap_proxy_endpoint: "1.2.3.4",
      });

      const res = await postMmzapBrowserRoute(
        new NextRequest("http://localhost/api/warmup/mmzap-browser", {
          method: "POST",
          body: JSON.stringify({ action: "logout", instance_name: "chip-foreign" }),
        })
      );

      expect(res.status).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(state.whatsapp_warmup_configs[0].mmzap_browser_status).toBe("running");
      expect(state.whatsapp_warmup_logs).toHaveLength(0);
    });

    it("executa logout completo, reseta campos no Supabase e grava log system claro", async () => {
      process.env.MMZAP_WORKER_URL = "http://worker.internal:3099";

      const calls: Array<{ url: string; method: string }> = [];
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), method: String(init?.method || "GET") });
        return new Response(
          JSON.stringify({
            ok: true,
            instanceName: "chip-01",
            loggedOutFromWhatsApp: true,
            profileWiped: true,
            profileDirExisted: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as unknown as typeof fetch;

      state.whatsapp_warmup_configs.push({
        client_id: "admin-1",
        instance_name: "chip-01",
        mmzap_browser_status: "running",
        mmzap_browser_enabled: true,
        mmzap_shift_started_at: "2026-11-26T15:00:00.000Z",
        mmzap_last_error: "qr_required",
        mmzap_proxy_endpoint: "185.72.242.164",
      });

      const res = await postMmzapBrowserRoute(
        new NextRequest("http://localhost/api/warmup/mmzap-browser", {
          method: "POST",
          body: JSON.stringify({ action: "logout", instance_name: "chip-01" }),
        })
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: { status: string; loggedOutFromWhatsApp: boolean; profileWiped: boolean };
      };
      expect(body.success).toBe(true);
      expect(body.data.status).toBe("unpaired");
      expect(body.data.loggedOutFromWhatsApp).toBe(true);
      expect(body.data.profileWiped).toBe(true);

      expect(calls).toEqual([
        { url: "http://worker.internal:3099/sessions/chip-01/logout", method: "POST" },
      ]);

      const row = state.whatsapp_warmup_configs[0];
      expect(row.mmzap_browser_status).toBe("unpaired");
      expect(row.mmzap_browser_enabled).toBe(false);
      expect(row.mmzap_shift_started_at).toBeNull();
      expect(row.mmzap_last_error).toBeNull();
      expect(row.mmzap_proxy_endpoint).toBeNull();

      expect(state.whatsapp_warmup_logs).toHaveLength(1);
      expect(state.whatsapp_warmup_logs[0]).toMatchObject({
        client_id: "admin-1",
        sender_instance: "chip-01",
        action_type: "system",
        message_text: "🚪 Sessão MMZap desconectada e perfil apagado automaticamente",
      });
    });

    it("alinha reset_profile ao mesmo fluxo logout+wipe e grava log system", async () => {
      process.env.MMZAP_WORKER_URL = "http://worker.internal:3099";

      const calls: string[] = [];
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(init?.method || "GET");
        calls.push(`${method} ${String(url)}`);
        if (method === "POST") {
          return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch;

      state.whatsapp_warmup_configs.push({
        client_id: "admin-1",
        instance_name: "chip-02",
        mmzap_browser_status: "error",
        mmzap_browser_enabled: true,
        mmzap_shift_started_at: "2026-11-26T14:00:00.000Z",
        mmzap_last_error: "worker_error",
        mmzap_proxy_endpoint: "10.0.0.1",
      });

      const res = await postMmzapBrowserRoute(
        new NextRequest("http://localhost/api/warmup/mmzap-browser", {
          method: "POST",
          body: JSON.stringify({ action: "reset_profile", instance_name: "chip-02" }),
        })
      );

      expect(res.status).toBe(200);
      expect(calls).toEqual([
        "POST http://worker.internal:3099/sessions/chip-02/logout",
        "DELETE http://worker.internal:3099/sessions/chip-02",
      ]);
      expect(state.whatsapp_warmup_configs[0].mmzap_browser_status).toBe("unpaired");
      expect(state.whatsapp_warmup_configs[0].mmzap_browser_enabled).toBe(false);
      expect(state.whatsapp_warmup_logs[0]?.message_text).toBe(
        "🚪 Sessão MMZap desconectada e perfil apagado automaticamente"
      );
    });
  });

  describe("session-manager.mjs (wipe recursivo, logoutSession e auto-wipe)", () => {
    it("removeDirectoryWithRetry faz retry em EBUSY/EPERM e apaga diretório recursivo completo", async () => {
      const mod = await import("../../../../services/mmzap-browser-worker/src/session-manager.mjs");

      // 1. Teste de retry com EBUSY -> EPERM -> sucesso
      let calls = 0;
      const flakyRm = vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          const e = new Error("resource busy") as NodeJS.ErrnoException;
          e.code = "EBUSY";
          throw e;
        }
        if (calls === 2) {
          const e = new Error("operation not permitted") as NodeJS.ErrnoException;
          e.code = "EPERM";
          throw e;
        }
      });

      const retryRes = await mod.removeDirectoryWithRetry("/fake/profile", {
        maxAttempts: 3,
        retryDelayMs: 5,
        rmImpl: flakyRm,
        existsImpl: async () => true,
      });

      expect(retryRes).toEqual({ existed: true, wiped: true, attempts: 3 });
      expect(flakyRm).toHaveBeenCalledTimes(3);

      // 2. Teste real em filesystem com locks, markers e subdiretórios
      const realDir = path.join(tmpDataDir, "profiles", "chip-real-wipe");
      await fs.mkdir(path.join(realDir, "Default", "IndexedDB"), { recursive: true });
      await fs.writeFile(path.join(realDir, "SingletonLock"), "lock", "utf8");
      await fs.writeFile(path.join(realDir, ".mmzap-setup-done"), "done", "utf8");
      await fs.writeFile(path.join(realDir, ".mmzap-logged-out"), "1", "utf8");
      await fs.writeFile(path.join(realDir, "Default", "IndexedDB", "session.ldb"), "data", "utf8");

      const realRes = await mod.removeDirectoryWithRetry(realDir, {
        maxAttempts: 3,
        retryDelayMs: 5,
      });
      expect(realRes.existed).toBe(true);
      expect(realRes.wiped).toBe(true);
      await expect(fs.access(realDir)).rejects.toThrow();
    });

    it("logoutSession realiza logout gracioso best-effort no WhatsApp Web, encerra Chromium e apaga perfil", async () => {
      const mod = await import("../../../../services/mmzap-browser-worker/src/session-manager.mjs");
      const mockCtx = createMockPlaywrightContext({
        authenticated: true,
        logoutButtonsVisible: true,
      });
      launchPersistentContextMock.mockResolvedValueOnce(mockCtx.context);

      const profileDir = path.join(tmpDataDir, "profiles", "chip-active");
      await fs.mkdir(path.join(profileDir, "Default"), { recursive: true });
      await fs.writeFile(path.join(profileDir, "Default", "Cookies"), "cookie-data", "utf8");
      await fs.writeFile(path.join(profileDir, ".mmzap-setup-done"), "2026-11-26", "utf8");

      const started = await mod.startShiftSession({
        instanceName: "chip-active",
        clientId: "admin-1",
        proxy: null,
        shiftDurationMinutes: 30,
      });
      expect(started.statusCode).toBe(200);

      const out = await mod.logoutSession("chip-active");
      expect(out.statusCode).toBe(200);
      expect(out.body).toEqual({
        ok: true,
        instanceName: "chip-active",
        loggedOutFromWhatsApp: true,
        profileWiped: true,
        profileDirExisted: true,
      });
      expect(mockCtx.clickedSelectors).toEqual([
        '[data-testid="menu"]',
        '[data-testid="mi-logout"]',
        '[data-testid="popup-controls-ok"]',
      ]);
      expect(mockCtx.context.close).toHaveBeenCalled();
      await expect(fs.access(profileDir)).rejects.toThrow();

      // Segunda chamada é idempotente com profileDirExisted: false
      const second = await mod.logoutSession("chip-active");
      expect(second.body).toEqual({
        ok: true,
        instanceName: "chip-active",
        loggedOutFromWhatsApp: false,
        profileWiped: true,
        profileDirExisted: false,
      });
    });

    it("stopSession com whatsapp_web_logged_out faz auto-wipe e startPairingSession(resetProfile) limpa perfil morto", async () => {
      const mod = await import("../../../../services/mmzap-browser-worker/src/session-manager.mjs");

      const profileA = path.join(tmpDataDir, "profiles", "chip-expired");
      await fs.mkdir(path.join(profileA, "Default"), { recursive: true });
      await fs.writeFile(path.join(profileA, "Default", "old-cookie"), "expired", "utf8");

      const stopOut = await mod.stopSession("chip-expired", "whatsapp_web_logged_out");
      expect(stopOut.statusCode).toBe(200);
      await expect(fs.access(profileA)).rejects.toThrow();

      // startPairingSession com resetProfile: true apaga arquivos antigos antes de abrir QR novo
      const profileB = path.join(tmpDataDir, "profiles", "chip-repair");
      await fs.mkdir(profileB, { recursive: true });
      const staleMarker = path.join(profileB, "stale-old-session.txt");
      await fs.writeFile(staleMarker, "stale", "utf8");

      const mockQrCtx = createMockPlaywrightContext({
        authenticated: false,
        logoutButtonsVisible: false,
      });
      launchPersistentContextMock.mockResolvedValueOnce(mockQrCtx.context);

      const pairOut = await mod.startPairingSession({
        instanceName: "chip-repair",
        clientId: "admin-1",
        proxy: null,
        shiftDurationMinutes: 30,
        resetProfile: true,
      });

      expect(pairOut.statusCode).toBe(200);
      expect(pairOut.body.status).toBe("qr_pending");
      await expect(fs.access(staleMarker)).rejects.toThrow();

      // Cleanup da sessão aberta em memória
      const delOut = await mod.deleteSessionProfile("chip-repair");
      expect(delOut.body.ok).toBe(true);
      expect(delOut.body.profileWiped).toBe(true);
      await expect(fs.access(profileB)).rejects.toThrow();
    });
  });
});
