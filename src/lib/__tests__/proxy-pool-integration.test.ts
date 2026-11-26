// @vitest-environment jsdom
import React from "react";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  evoSetProxy: vi.fn(),
  evoRemoveProxy: vi.fn(),
  evoFindProxy: vi.fn(),
  evoEnsureConfigured: vi.fn(),
  evoSetWebhook: vi.fn(),
  evoLogout: vi.fn(),
  evoDeleteInstance: vi.fn(),
  evoStatus: vi.fn(),
  goSetProxy: vi.fn(),
  goRemoveProxy: vi.fn(),
  proxyRows: [] as Array<Record<string, unknown>>,
  batchRows: [] as Array<Record<string, unknown>>,
  connRows: [] as Array<Record<string, unknown>>,
  warmupRows: [] as Array<Record<string, unknown>>,
  settingsRows: new Map<string, string>(),
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: mocks.auth,
  invalidateInstanceCache: vi.fn(),
  clientIdFromInstance: vi.fn(),
}));

vi.mock("@/lib/evolution", () => ({
  evolution: {
    setProxy: mocks.evoSetProxy,
    removeProxy: mocks.evoRemoveProxy,
    findProxy: mocks.evoFindProxy,
    ensureInstanceConfigured: mocks.evoEnsureConfigured,
    setWebhook: mocks.evoSetWebhook,
    logout: mocks.evoLogout,
    deleteInstance: mocks.evoDeleteInstance,
    getStatus: mocks.evoStatus,
    fetchProfilePicture: vi.fn().mockResolvedValue("https://pic.test/avatar.jpg"),
  },
}));

vi.mock("@/lib/providers/evolution-go", () => ({
  setEvolutionGoProxy: mocks.goSetProxy,
  removeEvolutionGoProxy: mocks.goRemoveProxy,
  evolutionGo: {},
}));

vi.mock("@/lib/channel", () => ({
  getStatus: mocks.evoStatus,
}));

vi.mock("@/lib/saas-limits", () => ({
  assertTenantCanCreateInstance: vi.fn().mockResolvedValue(null),
  assertTenantCanCreateAgent: vi.fn().mockResolvedValue(null),
  requireFeatureAccess: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/agent-config-cache", () => ({
  invalidateAgentConfigCache: vi.fn(),
}));

function matchesFilters(row: Record<string, unknown>, filters: Array<[string, string, unknown]>): boolean {
  return filters.every(([op, col, val]) => {
    const cur = row[col];
    if (op === "eq") return cur === val;
    if (op === "neq") return cur !== val;
    if (op === "in") return Array.isArray(val) && val.includes(cur);
    if (op === "lt") return typeof cur === "string" && typeof val === "string" && cur < val;
    return true;
  });
}

function getStore(table: string): Array<Record<string, unknown>> {
  if (table === "proxy_pool") return mocks.proxyRows;
  if (table === "proxy_pool_batches") return mocks.batchRows;
  if (table === "channel_connections") return mocks.connRows;
  if (table === "whatsapp_warmup_configs") return mocks.warmupRows;
  return [];
}

function createFakeTable(table: string) {
  const filters: Array<[string, string, unknown]> = [];
  let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  let payload: unknown = null;
  let limitVal: number | null = null;
  let headOnly = false;
  let wantCount = false;

  const execute = (): { data: unknown; error: null; count?: number } => {
    if (table === "app_settings") {
      if (op === "upsert" && payload && typeof payload === "object") {
        const p = payload as { key: string; value: string };
        mocks.settingsRows.set(p.key, p.value);
        return { data: p, error: null };
      }
      const keyEq = filters.find(([o, col]) => o === "eq" && col === "key")?.[2];
      if (typeof keyEq === "string") {
        const val = mocks.settingsRows.get(keyEq);
        return { data: val !== undefined ? { key: keyEq, value: val } : null, error: null };
      }
      return { data: [], error: null };
    }

    const store = getStore(table);

    if (op === "insert") {
      const arr = Array.isArray(payload) ? payload : [payload];
      const inserted = arr.map((item) => {
        const row = {
          id: (item as Record<string, unknown>).id || `id-${Math.random().toString(36).slice(2, 10)}`,
          fail_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...(item as Record<string, unknown>),
        };
        store.push(row);
        return { ...row };
      });
      return { data: inserted, error: null };
    }

    if (op === "update") {
      const updated: Array<Record<string, unknown>> = [];
      for (const row of store) {
        if (matchesFilters(row, filters)) {
          Object.assign(row, payload as Record<string, unknown>);
          updated.push({ ...row });
        }
      }
      return { data: updated, error: null };
    }

    if (op === "delete") {
      for (let i = store.length - 1; i >= 0; i--) {
        if (matchesFilters(store[i], filters)) store.splice(i, 1);
      }
      return { data: [], error: null };
    }

    let matched = store.filter((r) => matchesFilters(r, filters)).map((r) => ({ ...r }));
    const totalCount = matched.length;
    if (limitVal !== null) matched = matched.slice(0, limitVal);
    return {
      data: headOnly ? null : matched,
      error: null,
      ...(wantCount ? { count: totalCount } : {}),
    };
  };

  const chain: Record<string, unknown> = {
    select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
      if (op === "select") {
        wantCount = opts?.count === "exact";
        headOnly = Boolean(opts?.head);
      }
      return chain;
    },
    insert: (p: unknown) => {
      op = "insert";
      payload = p;
      return chain;
    },
    update: (p: unknown) => {
      op = "update";
      payload = p;
      return chain;
    },
    upsert: (p: unknown) => {
      op = "upsert";
      payload = p;
      return chain;
    },
    delete: () => {
      op = "delete";
      return chain;
    },
    eq: (col: string, val: unknown) => {
      filters.push(["eq", col, val]);
      return chain;
    },
    neq: (col: string, val: unknown) => {
      filters.push(["neq", col, val]);
      return chain;
    },
    in: (col: string, val: unknown[]) => {
      filters.push(["in", col, val]);
      return chain;
    },
    lt: (col: string, val: unknown) => {
      filters.push(["lt", col, val]);
      return chain;
    },
    order: () => chain,
    limit: (n: number) => {
      limitVal = n;
      return chain;
    },
    range: () => chain,
    single: async () => {
      const r = execute();
      const first = Array.isArray(r.data) ? r.data[0] || null : r.data;
      return { data: first, error: r.error };
    },
    maybeSingle: async () => {
      const r = execute();
      const first = Array.isArray(r.data) ? r.data[0] || null : r.data;
      return { data: first, error: r.error };
    },
    then: (resolve: (val: unknown) => unknown, reject: (err: unknown) => unknown) =>
      Promise.resolve(execute()).then(resolve, reject),
  };

  return chain;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (table: string) => createFakeTable(table),
  },
}));

import {
  parseWebshareProxyText,
  importProxyPoolBatch,
  ensureProxyForInstance,
  fallbackInstanceToVps,
  getProxyPoolOverviewCache,
  recordInstanceProxyStrike,
  retireInstanceProxyAsUsed,
  invalidateProxyPoolCache,
  saveProxyPoolSettings,
  getAdminProxyPoolSnapshot,
} from "@/lib/proxy-pool";
import { analyzeChipClusterHealth, auditChipDay0Hygiene } from "@/lib/warmup/warmup-groups";
import { AdminProxyPoolCard } from "@/components/admin-proxy-pool-card";

describe("Proxy Pool BR + Lista Negra + Fail-Open VPS", () => {
  beforeEach(() => {
    mocks.proxyRows.length = 0;
    mocks.batchRows.length = 0;
    mocks.connRows.length = 0;
    mocks.warmupRows.length = 0;
    mocks.settingsRows.clear();
    invalidateProxyPoolCache();

    mocks.auth.mockReset().mockResolvedValue({
      ok: true,
      clientId: "admin-tenant",
      isAdmin: true,
      impersonating: false,
      claims: { isAdmin: true },
    });
    mocks.evoSetProxy.mockReset().mockResolvedValue({ ok: true });
    mocks.evoRemoveProxy.mockReset().mockResolvedValue({ ok: true });
    mocks.evoFindProxy.mockReset().mockResolvedValue({ enabled: false });
    mocks.evoEnsureConfigured.mockReset().mockResolvedValue({ qrcode: { base64: "data:image/png;base64,QR" } });
    mocks.evoSetWebhook.mockReset().mockResolvedValue({ ok: true });
    mocks.evoLogout.mockReset().mockResolvedValue({ ok: true });
    mocks.evoDeleteInstance.mockReset().mockResolvedValue({ ok: true });
    mocks.evoStatus.mockReset().mockResolvedValue({ state: "close", data: null });
    mocks.goSetProxy.mockReset().mockResolvedValue({ ok: true });
    mocks.goRemoveProxy.mockReset().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("parser aceita formato Webshare BR, deduplica e bloqueia SSRF/portas inválidas", () => {
    const raw = [
      "# Comentário Webshare",
      "23.129.254.10:5992:myuser:mypass",
      "23.129.254.10:5992:myuser:mypass", // duplicado
      "127.0.0.1:8080:bad:bad", // SSRF loopback
      "192.168.1.10:3128:lan:lan", // SSRF LAN
      "10.0.0.5:3128:vpc:vpc", // SSRF privada
      "localhost:9000:u:p", // SSRF hostname local
      "198.51.100.20:70000:u:p", // porta inválida
      "socks5://u2:p2@198.51.100.30:1080",
    ].join("\n");

    const parsed = parseWebshareProxyText(raw, "http");
    expect(parsed.valid).toEqual([
      { host: "23.129.254.10", port: 5992, protocol: "http", username: "myuser", password: "mypass" },
      { host: "198.51.100.30", port: 1080, protocol: "socks5", username: "u2", password: "p2" },
    ]);
    expect(parsed.duplicateCount).toBe(1);
    expect(parsed.invalid.length).toBe(5);
  });

  it("mantém exclusividade 1:1, envia usados/falhos/banidos para Lista Negra e gira lista mensal atualizando instâncias", async () => {
    mocks.connRows.push(
      { id: "c1", instance_name: "evo-chip-1", client_id: "t1", provider: "evolution", status: "open", provider_config: { auto_proxy: true } },
      { id: "c2", instance_name: "go-chip-2", client_id: "t2", provider: "evolution_go", status: "open", provider_config: { auto_proxy: true } },
      { id: "c3", instance_name: "warm-chip-3", client_id: "t1", provider: "evolution", status: "open", provider_config: {} },
    );
    mocks.warmupRows.push({ client_id: "t1", instance_name: "warm-chip-3", enabled: true });

    // Mês 1: 3 proxies (exatamente 1 para cada instância, sem colisão)
    const batch1 = await importProxyPoolBatch({
      rawText: [
        "198.51.100.1:6001:u1:p1",
        "198.51.100.2:6002:u1:p1",
        "198.51.100.3:6003:u1:p1",
      ].join("\n"),
      protocol: "http",
      applyToInstances: true,
    });

    expect(batch1.addedCount).toBe(3);
    expect(batch1.migratedInstances).toBe(3);
    expect(mocks.evoSetProxy).toHaveBeenCalledWith("evo-chip-1", expect.objectContaining({ host: "198.51.100.1" }));
    expect(mocks.goSetProxy).toHaveBeenCalledWith("go-chip-2", expect.objectContaining({ host: "198.51.100.2" }));
    expect(mocks.evoSetProxy).toHaveBeenCalledWith("warm-chip-3", expect.objectContaining({ host: "198.51.100.3" }));

    // Exclui evo-chip-1 -> proxy 198.51.100.1 vai para Lista Negra ('used') e nunca vai pra outra instância
    await retireInstanceProxyAsUsed("evo-chip-1", "t1", "evolution");
    const usedRow = mocks.proxyRows.find((r) => r.host === "198.51.100.1")!;
    expect(usedRow.status).toBe("blacklisted");
    expect(usedRow.blacklist_reason).toBe("used");

    // Se re-importar a mesma lista acidentalmente no mês 1, 198.51.100.1 CONTINUA na Lista Negra
    const repeatImport = await importProxyPoolBatch({
      rawText: [
        "198.51.100.1:6001:u1:p1",
        "198.51.100.2:6002:u1:p1",
        "198.51.100.3:6003:u1:p1",
      ].join("\n"),
      applyToInstances: false,
    });
    expect(repeatImport.keptAssignedCount).toBe(2);
    expect(repeatImport.keptBlacklistedCount).toBe(1);

    // Chip novo entra sem proxy livre -> cai com segurança no fallback IP padrão da VPS sem quebrar!
    mocks.connRows.push({
      id: "c4",
      instance_name: "warm-chip-4",
      client_id: "t1",
      provider: "evolution",
      status: "open",
      provider_config: { auto_proxy: true },
    });
    const fallbackRes = await ensureProxyForInstance({
      instanceName: "warm-chip-4",
      clientId: "t1",
      reason: "warmup",
      forWarmup: true,
    });
    expect(fallbackRes.mode).toBe("vps_fallback");
    expect(fallbackRes.usedVpsFallback).toBe(true);
    expect(mocks.connRows.find((c) => c.instance_name === "warm-chip-4")?.provider_config).toMatchObject({
      proxy_mode: "vps_fallback",
      proxy_pending_rotation: true,
    });

    // Mês 2: nova lista rotativa mantém 198.51.100.2 (não derruba go-chip-2!), aposenta .1 e .3 e traz IPs novos
    mocks.evoSetProxy.mockClear();
    mocks.goSetProxy.mockClear();
    const batch2 = await importProxyPoolBatch({
      rawText: [
        "198.51.100.2:6002:u2:p2_nova", // manteve mesmo host com senha nova -> atualiza go-chip-2
        "203.0.113.10:7001:u2:p2_nova", // novo IP -> vai pra warm-chip-3 (que perdeu .3)
        "203.0.113.11:7002:u2:p2_nova", // novo IP -> resgata warm-chip-4 que estava esperando na VPS!
      ].join("\n"),
      applyToInstances: true,
    });

    expect(batch2.keptAssignedCount).toBe(1);
    expect(batch2.retiredCount).toBe(2); // .1 (blacklisted) e .3 (assigned que saiu)
    expect(batch2.migratedInstances).toBe(2); // warm-chip-3 + warm-chip-4 resgatada da VPS!
    expect(mocks.goSetProxy).toHaveBeenCalledWith(
      "go-chip-2",
      expect.objectContaining({ host: "198.51.100.2", password: "p2_nova" }),
    );
    expect(mocks.evoSetProxy).toHaveBeenCalledWith("warm-chip-3", expect.objectContaining({ host: "203.0.113.10" }));
    expect(mocks.evoSetProxy).toHaveBeenCalledWith("warm-chip-4", expect.objectContaining({ host: "203.0.113.11" }));
  });

  it("aplica circuito anti-tempestade de 3 strikes e failover sem quebrar sistema", async () => {
    await saveProxyPoolSettings({ strikeThreshold: 3, verifyBeforeAssign: false, allowVpsFallback: true });
    mocks.proxyRows.push(
      { id: "p1", host: "198.51.100.51", port: 5001, protocol: "http", username: "u", password: "p", status: "available", fail_count: 0, country_code: "BR" },
      { id: "p2", host: "198.51.100.52", port: 5002, protocol: "http", username: "u", password: "p", status: "available", fail_count: 0, country_code: "BR" },
    );
    mocks.connRows.push({
      id: "c1",
      instance_name: "warm-resiliente",
      client_id: "t1",
      provider: "evolution",
      status: "open",
      provider_config: { auto_proxy: true },
    });

    const initial = await ensureProxyForInstance({
      instanceName: "warm-resiliente",
      clientId: "t1",
      reason: "warmup",
      forWarmup: true,
    });
    expect(initial.host).toBe("198.51.100.51");

    // 1º e 2º timeout genérico não derrubam o proxy (evita tempestade em oscilação breve)
    const s1 = await recordInstanceProxyStrike({ instanceName: "warm-resiliente", clientId: "t1", errorMessage: "Timeout envio" });
    const s2 = await recordInstanceProxyStrike({ instanceName: "warm-resiliente", clientId: "t1", errorMessage: "Timeout envio" });
    expect(s1.action).toBe("strike");
    expect(s2.action).toBe("strike");

    // 3º strike envia p1 pra Lista Negra ('failed') e rotaciona sozinho para p2
    const s3 = await recordInstanceProxyStrike({ instanceName: "warm-resiliente", clientId: "t1", errorMessage: "Timeout envio" });
    expect(s3.action).toBe("rotated");
    expect(mocks.proxyRows.find((p) => p.id === "p1")).toMatchObject({ status: "blacklisted", blacklist_reason: "failed" });
    expect(mocks.proxyRows.find((p) => p.id === "p2")).toMatchObject({ status: "assigned", assigned_instance: "warm-resiliente" });

    // Se tomar BAN 401/403 -> p2 vai imediatamente para Lista Negra ('banned') sem gastar outro proxy
    const sBan = await recordInstanceProxyStrike({
      instanceName: "warm-resiliente",
      clientId: "t1",
      errorMessage: "401 loggedOut",
      isBan401Or403: true,
    });
    expect(sBan.action).toBe("blacklisted_banned");
    expect(mocks.proxyRows.find((p) => p.id === "p2")).toMatchObject({ status: "blacklisted", blacklist_reason: "banned" });
    expect(mocks.evoRemoveProxy).toHaveBeenCalledWith("warm-resiliente");
  });

  it("bloqueia rota /api/admin/proxies para não-admin e admin em impersonation e nunca vaza senhas", async () => {
    mocks.proxyRows.push({
      id: "p-secret",
      host: "198.51.100.99",
      port: 8888,
      protocol: "http",
      username: "secret_user",
      password: "SUPER_SECRET_PASSWORD_999",
      status: "assigned",
      assigned_instance: "chip-x",
      country_code: "BR",
      fail_count: 0,
    });

    const { GET } = await import("@/app/api/admin/proxies/route");

    mocks.auth.mockResolvedValueOnce({ ok: true, clientId: "t1", isAdmin: false, impersonating: false });
    expect((await GET(new NextRequest("http://localhost/api/admin/proxies"))).status).toBe(403);

    mocks.auth.mockResolvedValueOnce({ ok: true, clientId: "t1", isAdmin: true, impersonating: true });
    expect((await GET(new NextRequest("http://localhost/api/admin/proxies"))).status).toBe(403);

    mocks.auth.mockResolvedValueOnce({ ok: true, clientId: "admin-1", isAdmin: true, impersonating: false });
    const okRes = await GET(new NextRequest("http://localhost/api/admin/proxies"));
    expect(okRes.status).toBe(200);
    const bodyText = await okRes.text();
    expect(bodyText).not.toContain("SUPER_SECRET_PASSWORD_999");
    expect(bodyText).not.toContain("secret_user");

    const snap = await getAdminProxyPoolSnapshot();
    expect(snap.stats.assigned).toBe(1);
  });

  it("classifica Geo/ASN honestamente: alerta datacenter/estrangeiro e reporta vpsSharedCount no fallback VPS", async () => {
    // 1. Proxies Webshare não verificados/datacenter NÃO entram cegamente em brHosts
    mocks.proxyRows.push(
      {
        id: "p-dc",
        host: "198.51.100.77",
        port: 6000,
        protocol: "http",
        status: "assigned",
        assigned_instance: "chip-dc-1",
        country_code: "BR",
        provider_label: "webshare",
      },
      {
        id: "p-res",
        host: "198.51.100.78",
        port: 6001,
        protocol: "http",
        status: "available",
        country_code: "BR",
        provider_label: "webshare:br_residential",
      }
    );
    invalidateProxyPoolCache();

    const overview = await getProxyPoolOverviewCache();
    expect(overview.brHosts.has("198.51.100.77")).toBe(false);
    expect(overview.brHosts.has("198.51.100.78")).toBe(true);
    expect(overview.availableCount).toBe(1);

    // Proxy BR residencial limpo passa na saúde de cluster sem alertas falsos
    const cleanCluster = analyzeChipClusterHealth({
      clientId: "t1",
      instanceName: "chip-br-res",
      config: { client_id: "t1", instance_name: "chip-br-res", enabled: true } as never,
      proxyByInstance: new Map([["chip-br-res", { enabled: true, host: "198.51.100.78" }]]),
      proxyIntelByHost: new Map([
        ["198.51.100.78", { countryCode: "BR", country: "Brazil", hosting: false, isp: "Vivo Fibra", checkedAt: Date.now() }],
      ]),
    });
    expect(cleanCluster.proxyHosting).toBe(false);
    expect(cleanCluster.warnings).toEqual([]);

    // Proxy Datacenter é denunciado honestamente mesmo quando localizado no Brasil
    const dcCluster = analyzeChipClusterHealth({
      clientId: "t1",
      instanceName: "chip-dc-1",
      config: { client_id: "t1", instance_name: "chip-dc-1", enabled: true } as never,
      proxyByInstance: new Map([["chip-dc-1", { enabled: true, host: "198.51.100.77" }]]),
      proxyIntelByHost: new Map([
        ["198.51.100.77", { countryCode: "BR", country: "Brazil", hosting: true, isp: "Latitude.sh", checkedAt: Date.now() }],
      ]),
    });
    expect(dcCluster.proxyHosting).toBe(true);
    expect(dcCluster.warnings.some((w) => /Datacenter\/ASN/i.test(w))).toBe(true);

    // Auditoria Dia-0 flagra datacenter real quando fetch retorna hosting=true
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ status: "success", countryCode: "US", country: "United States", hosting: true, isp: "DigitalOcean" })
        )
      )
    );
    mocks.evoFindProxy.mockResolvedValueOnce({ enabled: true, host: "198.51.100.77", port: "6000" });
    mocks.warmupRows.push({ client_id: "t1", instance_name: "chip-dc-1", phone_number: "5511999998888" });
    const day0 = await auditChipDay0Hygiene("t1", "chip-dc-1", { forceInTests: true });
    expect(day0.ok).toBe(false);
    expect(day0.warnings.some((w) => /datacenter|estrangeiro/i.test(w))).toBe(true);

    // 2. Importação + ensureProxyForInstance gera geoWarning honesto quando proxy é datacenter/não-BR
    mocks.proxyRows.length = 0;
    mocks.connRows.push(
      { id: "c-geo", instance_name: "chip-geo", client_id: "t1", provider: "evolution", status: "open", provider_config: {} },
      { id: "c-vps-1", instance_name: "chip-vps-a", client_id: "t1", provider: "evolution", status: "open", provider_config: { proxy_mode: "direct" } },
      { id: "c-vps-2", instance_name: "chip-vps-b", client_id: "t1", provider: "evolution", status: "open", provider_config: { proxy_mode: "vps_fallback" } }
    );
    const importRes = await importProxyPoolBatch({
      rawText: "203.0.113.200:6000:u:p",
      applyToInstances: false,
      geoProbeFn: async () => ({
        countryCode: "US",
        country: "United States",
        hosting: true,
        proxy: true,
        isp: "Webshare DC",
        checkedAt: Date.now(),
      }),
    });
    expect(importRes.datacenterCount).toBe(1);
    expect(importRes.nonBrCount).toBe(1);
    expect(importRes.geoWarnings?.length).toBeGreaterThan(0);

    const assignedGeo = await ensureProxyForInstance({
      instanceName: "chip-geo",
      clientId: "t1",
      reason: "connect",
      geoProbeFn: async () => ({
        countryCode: "US",
        country: "United States",
        hosting: true,
        isp: "Webshare DC",
        checkedAt: Date.now(),
      }),
    });
    expect(assignedGeo.mode).toBe("pool_assigned");
    expect(assignedGeo.isDatacenter).toBe(true);
    expect(assignedGeo.countryCode).toBe("US");
    expect(assignedGeo.geoWarning).toMatch(/Datacenter\/ASN|fora do Brasil/i);

    // 3. Fallback VPS reporta vpsSharedCount com precisão (chip-vps-a + chip-vps-b = 2)
    const fbRes = await fallbackInstanceToVps("chip-novo-vps", "t1");
    expect(fbRes.vpsSharedCount).toBe(2);
    expect(fbRes.warning).toMatch(/2 outra\(s\) instância\(s\)/i);
  });

  it("renderiza AdminProxyPoolCard sob demanda e envia upload .txt para /api/admin/proxies", async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (method === "GET") {
        return new Response(
          JSON.stringify({
            success: true,
            tableReady: true,
            settings: { defaultProtocol: "http", warmupReserveCount: 10, strikeThreshold: 3, allowVpsFallback: true, verifyBeforeAssign: true },
            stats: { totalActive: 2, available: 1, assigned: 1, blacklisted: 0, blacklistBreakdown: { used: 0, failed: 0, banned: 0, manual: 0 }, vpsFallbackCount: 0 },
            assignedList: [{ id: "1", host: "198.51.100.1", port: 5992, protocol: "http", assignedInstance: "chip-1", assignedClientId: "t1", assignedAt: null, failCount: 0 }],
            blacklistList: [],
            fallbackInstances: [],
          }),
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          tableReady: true,
          importResult: { totalParsed: 1, duplicateCount: 0, invalidCount: 0, addedCount: 1, keptAssignedCount: 1, keptBlacklistedCount: 0, retiredCount: 0, migratedInstances: 0, vpsFallbackInstances: 0 },
          settings: { defaultProtocol: "http", warmupReserveCount: 10, strikeThreshold: 3, allowVpsFallback: true, verifyBeforeAssign: true },
          stats: { totalActive: 3, available: 2, assigned: 1, blacklisted: 0, blacklistBreakdown: { used: 0, failed: 0, banned: 0, manual: 0 }, vpsFallbackCount: 0 },
          assignedList: [],
          blacklistList: [],
          fallbackInstances: [],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(React.createElement(AdminProxyPoolCard));
    expect(fetchSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Pool de Proxies Rotativos/i }));
    await screen.findByText(/Atualizar Lista Mensal/i);

    const textarea = screen.getByPlaceholderText(/23\.129\.254\.10:5992/i);
    fireEvent.change(textarea, { target: { value: "203.0.113.50:5555:usr:pwd" } });
    fireEvent.click(screen.getByRole("button", { name: /Importar lista e aplicar/i }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/proxies",
        expect.objectContaining({
          method: "POST",
        }),
      ),
    );
    expect(await screen.findByText(/Lista importada e proxies atualizados/i)).toBeTruthy();
  });

  it("POST /api/whatsapp vincula proxy antes do QR Code quando autoProxy=true e faz fallback VPS se pool vazio", async () => {
    mocks.proxyRows.push({
      id: "p-conn",
      host: "203.0.113.88",
      port: 6100,
      protocol: "http",
      username: "u",
      password: "p",
      status: "available",
      country_code: "BR",
      fail_count: 0,
    });

    const events: string[] = [];
    mocks.evoSetProxy.mockImplementation(async (inst: string) => {
      events.push(`setProxy:${inst}`);
      return { ok: true };
    });
    mocks.evoEnsureConfigured.mockImplementation(
      async (inst: string, _url?: string, onBeforeConnect?: () => Promise<void>) => {
        if (onBeforeConnect) await onBeforeConnect();
        events.push(`connect:${inst}`);
        return { qrcode: { base64: "data:image/png;base64,QR_OK" } };
      },
    );

    const { POST: whatsappPost } = await import("@/app/api/whatsapp/route");
    const res1 = await whatsappPost(
      new NextRequest("http://localhost/api/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "connect", instanceName: "t1_chip_qr", autoProxy: true }),
      }),
    );
    const json1 = await res1.json();
    expect(res1.status).toBe(200);
    expect(json1.qrCode).toBe("data:image/png;base64,QR_OK");
    expect(events).toEqual(["setProxy:t1_chip_qr", "connect:t1_chip_qr"]);

    // Sem proxy livre -> t1_chip_2 NÃO quebra e gera QR pelo fallback padrão VPS!
    const res2 = await whatsappPost(
      new NextRequest("http://localhost/api/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "connect", instanceName: "t1_chip_2", autoProxy: true }),
      }),
    );
    const json2 = await res2.json();
    expect(res2.status).toBe(200);
    expect(json2.qrCode).toBe("data:image/png;base64,QR_OK");
    expect(mocks.evoRemoveProxy).toHaveBeenCalledWith("t1_chip_2");
    expect(mocks.connRows.find((c) => c.instance_name === "t1_chip_2")?.provider_config).toMatchObject({
      auto_proxy: true,
      proxy_mode: "vps_fallback",
      proxy_pending_rotation: true,
    });
  });

  it("PATCH /api/instances permite ativar/desativar auto_proxy por instância aposentando IP usado na Lista Negra", async () => {
    mocks.proxyRows.push({
      id: "p-inst",
      host: "203.0.113.90",
      port: 6200,
      protocol: "http",
      username: "u",
      password: "p",
      status: "available",
      country_code: "BR",
      fail_count: 0,
    });
    mocks.connRows.push({
      id: "c-patch",
      instance_name: "t1_inst_opt",
      client_id: "admin-tenant",
      provider: "evolution",
      status: "open",
      agent_id: 1,
      provider_config: {},
    });

    const { PATCH: instancesPatch } = await import("@/app/api/instances/route");

    const onRes = await instancesPatch(
      new NextRequest("http://localhost/api/instances", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance_name: "t1_inst_opt", auto_proxy: true }),
      }),
    );
    expect(onRes.status).toBe(200);
    expect(mocks.evoSetProxy).toHaveBeenCalledWith("t1_inst_opt", expect.objectContaining({ host: "203.0.113.90" }));

    const offRes = await instancesPatch(
      new NextRequest("http://localhost/api/instances", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance_name: "t1_inst_opt", auto_proxy: false }),
      }),
    );
    expect(offRes.status).toBe(200);
    expect(mocks.evoRemoveProxy).toHaveBeenCalledWith("t1_inst_opt");
    expect(mocks.proxyRows.find((p) => p.id === "p-inst")).toMatchObject({
      status: "blacklisted",
      blacklist_reason: "used",
    });
  });

  it("POST /api/whatsapp ativa autoProxy por padrão para Admin em chip novo, preserva webhook_secret no reconnect e aposenta proxy no delete", async () => {
    mocks.proxyRows.push({
      id: "p-admin-auto",
      host: "203.0.113.95",
      port: 6300,
      protocol: "http",
      username: "u",
      password: "p",
      status: "available",
      country_code: "BR",
      provider_label: "webshare:br_residential",
      fail_count: 0,
    });
    invalidateProxyPoolCache();

    const events: string[] = [];
    mocks.evoSetProxy.mockImplementation(async (inst: string) => {
      events.push(`setProxy:${inst}`);
      return { ok: true };
    });
    mocks.evoEnsureConfigured.mockImplementation(
      async (inst: string, url?: string, onBeforeConnect?: () => Promise<void>) => {
        if (onBeforeConnect) await onBeforeConnect();
        events.push(`connect:${inst}:${url ?? "no-url"}`);
        return { qrcode: { base64: "data:image/png;base64,QR_ADMIN" } };
      },
    );

    const { POST: whatsappPost } = await import("@/app/api/whatsapp/route");

    // 1. Admin omite autoProxy em instância nova -> ativa autoProxy=true automaticamente ANTES do 1º QR
    const resAdmin = await whatsappPost(
      new NextRequest("http://localhost/api/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "connect", instanceName: "admin_new_chip" }),
      }),
    );
    const jsonAdmin = await resAdmin.json();
    expect(resAdmin.status).toBe(200);
    expect(jsonAdmin.autoProxy).toBe(true);
    expect(events).toEqual(["setProxy:admin_new_chip", "connect:admin_new_chip:no-url"]);

    // 2. Reconexão de instância com webhook_secret salvo NÃO sobrescreve header (repassa secret para setWebhook)
    mocks.settingsRows.set("public_url", "https://app.example.test");
    mocks.connRows.push({
      id: "c-secret",
      instance_name: "chip_with_secret",
      client_id: "admin-tenant",
      provider: "evolution",
      status: "close",
      provider_config: { webhook_secret: "sec-xyz-999", auto_proxy: false },
    });
    const resReconn = await whatsappPost(
      new NextRequest("http://localhost/api/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "connect", instanceName: "chip_with_secret" }),
      }),
    );
    expect(resReconn.status).toBe(200);
    expect(mocks.evoSetWebhook).toHaveBeenCalledWith(
      "https://app.example.test/api/webhooks/whatsapp",
      "chip_with_secret",
      "sec-xyz-999"
    );

    // 3. action: "delete" aposenta o proxy atribuído na Lista Negra ('used') sem vazar assigned
    const resDel = await whatsappPost(
      new NextRequest("http://localhost/api/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", instanceName: "admin_new_chip" }),
      }),
    );
    expect(resDel.status).toBe(200);
    expect(mocks.proxyRows.find((p) => p.id === "p-admin-auto")).toMatchObject({
      status: "blacklisted",
      blacklist_reason: "used",
    });
  });
});
