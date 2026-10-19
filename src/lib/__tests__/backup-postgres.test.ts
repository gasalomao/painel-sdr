// @vitest-environment node
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const tools = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn(), readdir: vi.fn(), stat: vi.fn(), read: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: tools.spawn }));
vi.mock("node:fs", () => ({ existsSync: tools.exists, createReadStream: tools.read }));
vi.mock("node:fs/promises", () => ({ readdir: tools.readdir, stat: tools.stat }));
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv("POSTGRES_BIN_DIR", ""); tools.readdir.mockResolvedValue(["15", "17", "notes"]); tools.exists.mockReturnValue(true); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
vi.mock("@/lib/tenant", () => ({ requireClientId: vi.fn() }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: {} }));
import { ensureNonempty, fileDigest, postgresEnvironment, postgresTool, runBackupTool } from "../backup-postgres";
import { safeBackupError, BackupError } from "../backup-access";

function childProcess() {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  tools.spawn.mockReturnValue(child);
  return child;
}

describe("PostgreSQL offline tools", () => {
  it("uses configured tools or discovers the newest installed Windows version", async () => {
    vi.stubEnv("POSTGRES_BIN_DIR", "C:/tools");
    expect(await postgresTool("pg_dump")).toContain("pg_dump");
    vi.stubEnv("POSTGRES_BIN_DIR", "");
    if (process.platform === "win32") {
      expect(await postgresTool("pg_dump")).toContain("17");
      tools.exists.mockReturnValueOnce(false).mockReturnValueOnce(true);
      expect(await postgresTool("psql")).toContain("15");
      tools.exists.mockReturnValue(false);
      await expect(postgresTool("pg_restore")).rejects.toThrow("não encontradas");
      tools.readdir.mockRejectedValue(new Error("missing"));
      await expect(postgresTool("pg_dumpall")).rejects.toThrow("não encontradas");
    } else expect(await postgresTool("pg_dump")).toBe("pg_dump");
  });
  it("streams output without a shell and emits only safe activity logs", async () => {
    const child = childProcess(), log = vi.fn().mockResolvedValue(undefined);
    const result = runBackupTool("pg_dump", ["--version"], { PGPASSWORD: "fixture" }, log);
    child.stdout.emit("data", Buffer.from("version"));
    child.stderr.emit("data", Buffer.from("reading schemas password=fixture"));
    child.emit("close", 0);
    expect(await result).toBe("version");
    expect(tools.spawn).toHaveBeenCalledWith("pg_dump", ["--version"], expect.objectContaining({ shell: false, windowsHide: true }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("fixture");
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    ["password authentication failed", "Senha"], ["could not connect", "inacessível"],
    ["server version mismatch", "mais antigo"], ["permission denied", "permissão"], ["private detail", "falhou"],
  ])("sanitizes subprocess error %s", async (stderr, expected) => {
    const child = childProcess();
    const result = runBackupTool("pg_dump", [], {});
    child.stderr.emit("data", Buffer.from(stderr)); child.emit("close", 1);
    await expect(result).rejects.toThrow(expected);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("handles spawn failure, timeout and logging failure without confirming output", async () => {
    let child = childProcess();
    let result = runBackupTool("pg_dump", [], {});
    child.emit("error", new Error("private"));
    await expect(result).rejects.toThrow("executar");
    child = childProcess(); result = runBackupTool("pg_dump", [], {});
    vi.advanceTimersByTime(3_600_000); expect(child.kill).toHaveBeenCalledOnce(); child.emit("close", 0);
    await expect(result).rejects.toThrow("uma hora");
    child = childProcess(); result = runBackupTool("pg_dump", [], {}, vi.fn().mockRejectedValue(new Error("log offline")));
    child.stderr.emit("data", Buffer.from("dumping contents of table")); child.emit("close", 0);
    await expect(result).rejects.toThrow("log offline");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps the default backup timeout waiting for process shutdown", async () => {
    const child = childProcess();
    const result = runBackupTool("pg_dump", [], {});
    const settled = vi.fn();
    void result.then(settled, settled);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    child.emit("close", 0);
    await expect(result).rejects.toThrow("uma hora");
  });
  it("supports a short diagnostic timeout without waiting for a close event", async () => {
    const child = childProcess();
    const result = runBackupTool("psql", [], {}, undefined, 20_000);
    const rejection = expect(result).rejects.toThrow("prazo");
    vi.advanceTimersByTime(19_999);
    expect(child.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(child.kill).toHaveBeenCalledOnce();
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("verifies digest and rejects empty or unreadable exported files", async () => {
    tools.read.mockImplementation(() => Readable.from([Buffer.from("abc")]));
    expect(await fileDigest("fixture")).toBe(createHash("sha256").update("abc").digest("hex"));
    expect(await fileDigest("fixture", "md5")).toBe(createHash("md5").update("abc").digest("hex"));
    tools.stat.mockResolvedValueOnce({ size: 3 }).mockResolvedValueOnce({ size: 0 }).mockRejectedValueOnce(new Error("missing"));
    expect(await ensureNonempty("fixture")).toBe(3);
    await expect(ensureNonempty("fixture")).rejects.toThrow("vazio");
    await expect(ensureNonempty("fixture")).rejects.toThrow("missing");
  });
});

describe("PostgreSQL backup connection boundary", () => {
  it("decodes special characters without interpolating a shell", () => {
    const env = postgresEnvironment("postgresql://user:p%40ss%24%3Bword@private-db:5433/postgres?sslmode=require");
    expect(env.PGPASSWORD).toBe("p@ss$;word");
    expect(env.PGHOST).toBe("private-db");
    expect(env.PGPORT).toBe("5433");
    expect(env.PGSSLMODE).toBe("require");
  });
  it("rejects HTTP endpoints, missing credentials and invalid SSL mode", () => {
    for (const url of ["https://api.example.test", "postgresql://user@db/postgres", "postgres://:pass@db/postgres", "postgres://user:pass@db/", "postgres://user:pass@db/postgres?sslmode=invalid"]) expect(() => postgresEnvironment(url)).toThrow();
    expect(postgresEnvironment("postgres://user:pass@db/postgres")).toMatchObject({ PGPORT: "5432", PGSSLMODE: "prefer" });
  });
  it("does not relay SDK or legacy subprocess errors containing passwords", () => {
    const result = safeBackupError(new Error('Command failed: PGPASSWORD="secret" pg_dump'));
    expect(result).not.toContain("secret");
    expect(result).not.toContain("Command failed");
  });
  it("shows only deliberately constructed actionable errors", () => {
    expect(safeBackupError(new BackupError("Conexão remota indisponível."))).toBe("Conexão remota indisponível.");
  });
});
