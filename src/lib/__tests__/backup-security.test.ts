import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const auth = vi.hoisted(() => ({ tenant: vi.fn(), admin: null as object | null }));
vi.mock("@/lib/tenant", () => ({ requireClientId: auth.tenant }));
vi.mock("@/lib/supabase_admin", () => ({ get supabaseAdmin() { return auth.admin; } }));
import { backupDatabase, requireBackupAdmin } from "../backup-access";

beforeEach(() => {
  auth.tenant.mockResolvedValue({ ok: true, isAdmin: true, impersonating: false, clientId: "test" });
  auth.admin = {};
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
const request = (path: string, method = "GET", origin?: string) => new NextRequest(`https://app.example.test/api/backup/${path}`, { method, headers: origin ? { origin } : undefined });

describe("backup administrative boundary", () => {
  it("propagates unauthenticated response and denies members or impersonation", async () => {
    const denied = { ok: false, response: new Response(null, { status: 401 }) };
    auth.tenant.mockResolvedValueOnce(denied);
    expect(await requireBackupAdmin(request("config"))).toBe(denied);
    for (const patch of [{ isAdmin: false }, { impersonating: true }]) {
      auth.tenant.mockResolvedValueOnce({ ok: true, isAdmin: true, impersonating: false, clientId: "test", ...patch });
      const result = await requireBackupAdmin(request("config"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(403);
    }
  });
  it("requires matching origin on mutations and allows read methods", async () => {
    for (const origin of [undefined, "https://evil.example.test"]) {
      const result = await requireBackupAdmin(request("config", "POST", origin));
      if (result.ok) throw new Error("Mutation incorrectly authorized");
      expect(result.response.status).toBe(403);
    }
    expect((await requireBackupAdmin(request("config", "HEAD"))).ok).toBe(true);
    expect((await requireBackupAdmin(request("config", "POST", "https://app.example.test"))).ok).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect((await requireBackupAdmin(request("history", "PATCH", "https://app.example.test"))).ok).toBe(true);
  });
  it("throttles protected operations and expires local entries", async () => {
    const req = request("diagnostics");
    expect((await requireBackupAdmin(req)).ok).toBe(true);
    const blocked = await requireBackupAdmin(req);
    if (blocked.ok) throw new Error("Repeated action incorrectly authorized");
    expect(blocked.response.status).toBe(429);
    vi.advanceTimersByTime(61_000);
    expect((await requireBackupAdmin(request("google/auth"))).ok).toBe(true);
    expect((await requireBackupAdmin(req)).ok).toBe(true);
  });
  it("requires an administrative database client", () => {
    expect(backupDatabase()).toBe(auth.admin);
    auth.admin = null;
    expect(() => backupDatabase()).toThrow("não configurado");
  });
});

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");

describe("backup safety regression", () => {
  it("never interpolates database credentials into a shell", () => {
    const service = source("src/lib/backup-service.ts");
    expect(service).not.toContain("execAsync");
    expect(service).not.toContain("2>&1");
    expect(service).not.toContain("$env:PGPASSWORD");
  });

  it("requires administrative authorization on every backup endpoint", () => {
    for (const path of ["config", "create", "history", "restore", "google/auth", "google/callback"]) {
      expect(source(`src/app/api/backup/${path}/route.ts`)).toContain("requireBackupAdmin");
    }
  });

  it("gives the backup page an internal scrolling viewport", () => {
    const page = source("src/app/admin/backup/page.tsx");
    expect(page).toContain("overflow-y-auto");
    expect(page).toContain("h-full");
    expect(page).not.toContain("min-h-screen");
  });
});
