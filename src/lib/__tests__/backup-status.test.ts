// @vitest-environment node
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), config: vi.fn(), publicConfig: vi.fn(), database: vi.fn() }));
vi.mock("@/lib/backup-access", () => ({ requireBackupAdmin: mocks.admin, backupDatabase: mocks.database, safeBackupError: () => "Erro seguro." }));
vi.mock("@/lib/backup-config", () => ({ loadBackupConfig: mocks.config, publicBackupConfig: mocks.publicConfig }));
import { GET } from "@/app/api/backup/config/route";

let operations: { columns: string; filters: unknown[]; active: boolean; latest: boolean }[];
let storageError: boolean;
beforeEach(() => {
  operations = []; storageError = false;
  mocks.admin.mockResolvedValue({ ok: true, clientId: "admin-one" });
  mocks.config.mockResolvedValue({ id: 1 }); mocks.publicConfig.mockReturnValue({ enabled: false });
  mocks.database.mockImplementation(() => ({ from: () => {
    const operation = { columns: "", filters: [] as unknown[], active: false, latest: false };
    operations.push(operation);
    const builder = {
      select(columns: string) { operation.columns = columns; return builder; },
      eq(column: string, value: string) { operation.filters.push([column, value]); return builder; },
      in() { operation.active = true; return builder; },
      order() { operation.latest = true; return builder; },
      async limit() { return { error: storageError ? {} : null, data: operation.active ? [] : [{ id: "last-failed", status: "failed" }] }; },
    };
    return builder;
  } }));
});
afterEach(() => vi.unstubAllEnvs());

describe("Estado persistido de backup", () => {
  it("devolve última execução falha mesmo sem backup ativo, isolada por administrador", async () => {
    const result = await GET(new NextRequest("https://app.test/api/backup/config"));
    expect(await result.json()).toMatchObject({ success: true, activeRun: null, latestRun: { id: "last-failed", status: "failed" } });
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    for (const query of operations) {
      expect(query.columns).not.toContain("*");
      expect(query.filters).toContainEqual(["client_id", "admin-one"]);
    }
  });
  it("não consulta dados sem autorização", async () => {
    mocks.admin.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ success: false }, { status: 403 }) });
    expect((await GET(new NextRequest("https://app.test/api/backup/config"))).status).toBe(403);
    expect(mocks.config).not.toHaveBeenCalled(); expect(mocks.database).not.toHaveBeenCalled();
  });
  it("não retorna estado aprovado quando o schema de execuções está indisponível", async () => {
    storageError = true;
    const result = await GET(new NextRequest("https://app.test/api/backup/config"));
    expect(result.status).toBe(503);
    expect((await result.json()).error).toContain("020_backup_security_runs.sql");
  });
});
