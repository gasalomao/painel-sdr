// @vitest-environment node
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(), database: vi.fn(), tool: vi.fn(), run: vi.fn(), config: vi.fn(),
}));
vi.mock("@/lib/backup-access", () => ({
  requireBackupAdmin: mocks.admin,
  backupDatabase: mocks.database,
  BackupError: class BackupError extends Error {},
}));
vi.mock("@/lib/backup-config", () => ({ loadBackupConfig: mocks.config }));
vi.mock("@/lib/backup-postgres", async importOriginal => ({
  ...await importOriginal<typeof import("../backup-postgres")>(),
  postgresTool: mocks.tool, runBackupTool: mocks.run,
}));
import { listBackupDiagnostics, runBackupDiagnostics } from "../backup-diagnostics";
import { GET, POST } from "@/app/api/backup/diagnostics/route";

const report = {
  id: "924d09f3-b755-4129-8b00-b938b710fecd", status: "running", checks: [],
  created_at: "2026-10-19T10:00:00.000Z", completed_at: null,
};
let stored: Record<string, unknown>;
let insertError: unknown;
let updateError: unknown;
let listError: unknown;
let listed: unknown[];
let operations: { kind: string; value?: unknown; filters: [string, unknown][]; columns?: string; limit?: number; order?: unknown }[];

function database() {
  return { from: vi.fn((table: string) => {
    expect(table).toBe("backup_diagnostics");
    const operation: typeof operations[number] = { kind: "list", filters: [] };
    operations.push(operation);
    const builder = {
      insert(value: Record<string, unknown>) { operation.kind = "insert"; operation.value = value; stored = { ...report, ...value }; return builder; },
      update(value: Record<string, unknown>) { operation.kind = "update"; operation.value = value; return builder; },
      select(columns: string) { operation.columns = columns; return builder; },
      eq(column: string, value: unknown) { operation.filters.push([column, value]); return builder; },
      order(column: string, value: unknown) { operation.order = [column, value]; return builder; },
      limit(value: number) { operation.limit = value; return builder; },
      async single() {
        if (operation.kind === "insert") return { data: { ...stored }, error: insertError };
        stored = { ...stored, ...operation.value as object };
        return { data: { ...stored }, error: updateError };
      },
      then(resolve: (value: unknown) => void) { resolve({ data: listed, error: listError }); },
    };
    return builder;
  }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  insertError = null; updateError = null; listError = null; listed = []; operations = []; stored = {};
  mocks.database.mockImplementation(database);
  mocks.admin.mockResolvedValue({ ok: true, clientId: "admin-client" });
  mocks.tool.mockImplementation(async (name: string) => name);
  mocks.config.mockResolvedValue({ encrypted_tokens: "fixture-encrypted-not-to-be-returned" });
  mocks.run.mockImplementation(async (command: string, args: string[]) => {
    if (args.includes("SHOW server_version_num")) return "170004\n";
    if (command === "tar") return "tar (GNU tar) 1.35\nCopyright fixture-secret";
    return `${command} (PostgreSQL) 17.4 (fixture-secret-distribution)\n`;
  });
  vi.stubEnv("DATABASE_URL", "postgresql://fixture-user:fixture-password@fixture-host:5432/fixture-db?sslmode=require");
  vi.stubEnv("GOOGLE_CLIENT_ID", "fixture-google-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "fixture-google-secret");
  vi.stubEnv("GOOGLE_REDIRECT_URI", "https://fixture-app.test/api/backup/google/callback");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://fixture-app.test");
  vi.stubEnv("BACKUP_TOKEN_KEY", "a".repeat(64));
  vi.stubEnv("BACKUP_WORKER_ENABLED", "true");
});
afterEach(() => { vi.unstubAllEnvs(); });

function request(method: "GET" | "POST"): NextRequest {
  return new NextRequest("https://app.test/api/backup/diagnostics", { method });
}

function expectSanitized(value: unknown) {
  const json = JSON.stringify(value);
  for (const secret of ["fixture-user", "fixture-password", "fixture-host", "fixture-db", "fixture-secret", "fixture-google", "fixture-app", "fixture-encrypted", "https://", "postgresql://", "a".repeat(64)]) expect(json).not.toContain(secret);
}

describe("backup diagnostics persistence and checks", () => {
  it("saves running before checks and persists the full sanitized report scoped to the admin", async () => {
    mocks.run.mockImplementation(async (command: string, args: string[]) => {
      expect(operations[0]).toMatchObject({ kind: "insert", value: { client_id: "admin-client", status: "running", checks: [] } });
      if (args.includes("SHOW server_version_num")) return "170004\n";
      return command === "tar" ? "bsdtar 3.7.2 - fixture-secret" : `${command} (PostgreSQL) 17.4 fixture-secret`;
    });
    const result = await runBackupDiagnostics("admin-client");
    expect(result).toMatchObject({ id: report.id, status: "success", created_at: report.created_at, completed_at: expect.any(String) });
    expect(result.checks.map(check => check.name)).toEqual(expect.arrayContaining(["pg_dump", "pg_dumpall", "pg_restore", "psql", "tar", "DATABASE_URL", "server_version", "pg_dump_compatibility", "pg_dumpall_compatibility", "pg_restore_compatibility", "GOOGLE_OAUTH", "GOOGLE_DRIVE", "BACKUP_TOKEN_KEY", "BACKUP_WORKER_ENABLED"]));
    const update = operations.find(operation => operation.kind === "update");
    expect(update?.filters).toEqual(expect.arrayContaining([["client_id", "admin-client"], ["id", report.id]]));
    expect(update?.value).toMatchObject({ status: "success", checks: result.checks });
    expect(result).not.toHaveProperty("client_id");
    expectSanitized(result); expectSanitized(update?.value);
    const connection = mocks.run.mock.calls.find(call => (call[1] as string[]).includes("SHOW server_version_num"));
    expect(connection?.[1]).toEqual(["-X", "-w", "-At", "-v", "ON_ERROR_STOP=1", "-c", "SHOW server_version_num"]);
    expect(connection?.[2]).toMatchObject({ PGCONNECT_TIMEOUT: "15", PGOPTIONS: expect.stringContaining("statement_timeout=15000") });
    expect(connection?.[4]).toBe(20_000);
    for (const call of mocks.run.mock.calls.filter(call => (call[1] as string[]).includes("--version"))) expect(call[4]).toBe(5_000);
  });

  it("continues every tool and config check after failures without storing thrown details", async () => {
    mocks.run.mockRejectedValue(new Error("fixture-secret postgresql://fixture-user:fixture-password@fixture-host"));
    mocks.config.mockRejectedValue(new Error("fixture-google-secret"));
    const result = await runBackupDiagnostics("admin-client");
    expect(result.status).toBe("failed");
    for (const name of ["pg_dump", "pg_dumpall", "pg_restore", "psql", "tar", "GOOGLE_DRIVE"]) expect(result.checks.find(check => check.name === name)?.status).toBe("failed");
    expect(mocks.run.mock.calls.filter(call => (call[1] as string[]).includes("--version"))).toHaveLength(5);
    expectSanitized(result); expectSanitized(operations.at(-1)?.value);
  });

  it("does not execute tools when the initial history write fails", async () => {
    insertError = { code: "42P01", message: "fixture-secret" };
    await expect(runBackupDiagnostics("admin-client")).rejects.toThrow("022_backup_diagnostics.sql");
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.tool).not.toHaveBeenCalled(); expect(mocks.config).not.toHaveBeenCalled();
  });

  it("fails closed when history storage is unavailable or returns no row", async () => {
    mocks.database.mockImplementationOnce(() => { throw new Error("fixture-secret"); });
    await expect(runBackupDiagnostics("admin-client")).rejects.toThrow("022_backup_diagnostics.sql");
    expect(mocks.run).not.toHaveBeenCalled();
    mocks.database.mockReturnValueOnce({ from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }) }) });
    await expect(runBackupDiagnostics("admin-client")).rejects.toThrow("022_backup_diagnostics.sql");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("continues other checks if tool discovery fails", async () => {
    mocks.tool.mockImplementation(async (name: string) => {
      if (name === "pg_dump") throw new Error("fixture-secret");
      return name;
    });
    const result = await runBackupDiagnostics("admin-client");
    expect(result.status).toBe("failed");
    expect(result.checks.find(check => check.name === "pg_dump")?.status).toBe("failed");
    expect(result.checks.find(check => check.name === "tar")?.status).toBe("success");
    expect(result.checks.find(check => check.name === "server_version")?.status).toBe("success");
    expectSanitized(result);
  });

  it("keeps the initial running entry when completion cannot be persisted", async () => {
    updateError = { code: "42501", message: "fixture-secret" };
    await expect(runBackupDiagnostics("admin-client")).rejects.toThrow("022_backup_diagnostics.sql");
    expect(operations[0].value).toMatchObject({ status: "running", checks: [] });
  });

  it.each(["", "https://fixture-host", "postgresql://fixture-user@fixture-host/postgres", "postgres://fixture-user:fixture-password@fixture-host/%ZZ"])("rejects invalid DATABASE_URL %s without making a connection", async url => {
    vi.stubEnv("DATABASE_URL", url);
    const result = await runBackupDiagnostics("admin-client");
    expect(result.checks.find(check => check.name === "DATABASE_URL")?.status).toBe("failed");
    expect(mocks.run.mock.calls.some(call => (call[1] as string[]).includes("SHOW server_version_num"))).toBe(false);
    expectSanitized(result);
  });

  it("detects both dump/server and restore/dump incompatibility", async () => {
    mocks.run.mockImplementation(async (command: string, args: string[]) => {
      if (args.includes("SHOW server_version_num")) return "180001";
      return command === "tar" ? "tar (GNU tar) 1.35" : `${command} (PostgreSQL) ${command === "pg_restore" ? "16.8" : "17.4"}`;
    });
    const result = await runBackupDiagnostics("admin-client");
    expect(result.checks.find(check => check.name === "pg_dump_compatibility")?.status).toBe("failed");
    expect(result.checks.find(check => check.name === "pg_restore_compatibility")?.status).toBe("failed");
  });

  it("rejects an older pg_dumpall even when dump, restore and server are aligned", async () => {
    const normalRun = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation((command: string, args: string[]) => command === "pg_dumpall"
      ? Promise.resolve("pg_dumpall (PostgreSQL) 16.8") : normalRun(command, args));
    const result = await runBackupDiagnostics("admin-client");
    expect(result.status).toBe("failed");
    expect(result.checks.find(check => check.name === "pg_dump_compatibility")?.status).toBe("success");
    expect(result.checks.find(check => check.name === "pg_dumpall_compatibility")?.status).toBe("failed");
  });

  it("does not misclassify older PostgreSQL 9.x minor series as compatible", async () => {
    mocks.run.mockImplementation(async (command: string, args: string[]) => {
      if (args.includes("SHOW server_version_num")) return "90624";
      return command === "tar" ? "tar (GNU tar) 1.35" : `${command} (PostgreSQL) 9.5.25`;
    });
    const result = await runBackupDiagnostics("admin-client");
    expect(result.checks.find(check => check.name === "pg_dump_compatibility")?.status).toBe("failed");
  });

  it("rejects unrecognized version outputs instead of returning arbitrary stdout", async () => {
    mocks.run.mockResolvedValue("fixture-secret 123 https://fixture-host");
    const result = await runBackupDiagnostics("admin-client");
    expect(result.checks.find(check => check.name === "pg_dump")?.status).toBe("failed");
    expect(result.checks.find(check => check.name === "server_version")?.status).toBe("failed");
    expectSanitized(result);
  });

  it("warns about the disabled worker without activating it and checks Google locally only", async () => {
    vi.stubEnv("BACKUP_WORKER_ENABLED", "false");
    mocks.config.mockResolvedValue(null);
    const result = await runBackupDiagnostics("admin-client");
    expect(result.status).toBe("warning");
    expect(result.checks.find(check => check.name === "BACKUP_WORKER_ENABLED")?.status).toBe("warning");
    expect(result.checks.find(check => check.name === "GOOGLE_DRIVE")?.status).toBe("warning");
    expect(result.checks.find(check => check.name === "GOOGLE_OAUTH")?.message).toContain("EasyPanel");
    expect(result.checks.some(check => /não (comprova|valida).*recuperação/i.test(check.message))).toBe(true);
    expect(mocks.config).toHaveBeenCalledWith("admin-client");
    expect(process.env.BACKUP_WORKER_ENABLED).toBe("false");
  });

  it("checks required OAuth env and accepts app URL only as a redirect fallback", async () => {
    vi.stubEnv("GOOGLE_REDIRECT_URI", "");
    let result = await runBackupDiagnostics("admin-client");
    expect(result.checks.find(check => check.name === "GOOGLE_OAUTH")?.status).toBe("success");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "invalid-fixture-secret"); vi.stubEnv("BACKUP_TOKEN_KEY", "bad-fixture-secret");
    result = await runBackupDiagnostics("admin-client");
    expect(result.checks.find(check => check.name === "GOOGLE_OAUTH")?.status).toBe("failed");
    expect(result.checks.find(check => check.name === "BACKUP_TOKEN_KEY")?.status).toBe("failed");
    expectSanitized(result);
  });

  it("lists only explicit report columns, newest first, up to 20 and scoped to the admin", async () => {
    listed = [report];
    expect(await listBackupDiagnostics("admin-client")).toEqual([report]);
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.config).not.toHaveBeenCalled();
    expect(operations[0]).toMatchObject({ kind: "list", filters: [["client_id", "admin-client"]], limit: 20, order: ["created_at", { ascending: false }] });
    expect(operations[0].columns).toBe("id,status,checks,created_at,completed_at");
  });
});

describe("backup diagnostics API", () => {
  it.each(["GET", "POST"] as const)("denies %s without checks or persistence and returns no-store", async method => {
    mocks.admin.mockResolvedValue({ ok: false, response: NextResponse.json({ success: false }, { status: 403 }) });
    const response = await (method === "GET" ? GET : POST)(request(method));
    expect(response.status).toBe(403); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.database).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });
  it("returns HTTP 200 for a completed failed report", async () => {
    mocks.run.mockRejectedValue(new Error("fixture-secret"));
    const response = await POST(request("POST"));
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ success: true, diagnostic: { id: report.id, status: "failed" } }); expectSanitized(body);
  });
  it("GET only reads saved tests", async () => {
    listed = [report];
    const response = await GET(request("GET"));
    expect(await response.json()).toEqual({ success: true, diagnostics: [report] });
    expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(mocks.run).not.toHaveBeenCalled();
  });
  it.each(["GET", "POST"] as const)("returns a safe actionable 503 for %s persistence errors", async method => {
    insertError = listError = { message: "fixture-secret fixture-password" };
    const response = await (method === "GET" ? GET : POST)(request(method));
    expect(response.status).toBe(503); expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.success).toBe(false); expect(body.error).toContain("022_backup_diagnostics.sql"); expectSanitized(body);
  });
});

describe("backup diagnostics migration offline", () => {
  it("is idempotent, permits running/parallel diagnostics, validates checks and restricts client roles", async () => {
    const db = new PGlite();
    try {
      await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
      const sql = readFileSync("migrations/022_backup_diagnostics.sql", "utf8");
      await db.exec(sql); await db.exec(sql);
      await db.exec("SET ROLE service_role;");
      await db.query("INSERT INTO public.backup_diagnostics(client_id) VALUES ('admin-a'), ('admin-b')");
      const running = await db.query<{ status: string; checks: unknown[] }>("SELECT status, checks FROM public.backup_diagnostics");
      expect(running.rows).toHaveLength(2); expect(running.rows[0]).toMatchObject({ status: "running", checks: [] });
      await expect(db.query("INSERT INTO public.backup_diagnostics(client_id, status) VALUES ('admin-a', 'invalid')")).rejects.toThrow();
      await expect(db.query("INSERT INTO public.backup_diagnostics(client_id, checks) VALUES ('admin-a', '{}')")).rejects.toThrow();
      await db.exec("RESET ROLE; SET ROLE authenticated;");
      await expect(db.query("SELECT * FROM public.backup_diagnostics")).rejects.toThrow(/permission denied/i);
      await db.exec("RESET ROLE; GRANT SELECT ON public.backup_diagnostics TO authenticated; SET ROLE authenticated;");
      expect((await db.query("SELECT * FROM public.backup_diagnostics")).rows).toEqual([]);
      await db.exec("RESET ROLE; SET ROLE anon;");
      await expect(db.query("SELECT * FROM public.backup_diagnostics")).rejects.toThrow(/permission denied/i);
    } finally { await db.close(); }
  }, 30_000);
});
