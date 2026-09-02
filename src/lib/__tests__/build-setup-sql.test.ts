import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const scriptPath = resolve(process.cwd(), "scripts/build-setup-sql.mjs");
const tempDirs: string[] = [];

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "painel-build-sql-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("scripts/build-setup-sql.mjs", () => {
  it("gera setup-sql.ts exclusivamente da migration canônica", () => {
    const cwd = makeTempProject();
    mkdirSync(join(cwd, "migrations"), { recursive: true });
    writeFileSync(join(cwd, "SETUP_COMPLETO.sql"), "SELECT 'RAIZ_ERRADA';\n", "utf8");
    writeFileSync(join(cwd, "migrations", "SETUP_COMPLETO.sql"), "SELECT 'CANONICA';\n", "utf8");

    const result = spawnSync(process.execPath, [scriptPath], { cwd, encoding: "utf8" });

    expect(result.status).toBe(0);
    const generated = readFileSync(join(cwd, "src", "lib", "setup-sql.ts"), "utf8");
    expect(generated).toContain("SELECT 'CANONICA'");
    expect(generated).not.toContain("RAIZ_ERRADA");
    expect(generated).toContain("migrations/SETUP_COMPLETO.sql");
  });

  it("a fonte canônica inclui colunas incrementais exigidas pelo runtime", () => {
    const canonical = readFileSync(resolve(process.cwd(), "migrations", "SETUP_COMPLETO.sql"), "utf8");

    expect(canonical).toMatch(/openrouter_keys\s+jsonb/i);
    expect(canonical).toMatch(/ai_combos\s+jsonb/i);
    expect(canonical).toMatch(/unique index idx_leads_extraidos_client_remotejid[\s\S]*client_id, "remoteJid"/i);
    expect(canonical).toMatch(/alter column client_id set not null/i);
    expect(canonical).toMatch(/disable_groups\s+boolean/i);
    expect(canonical).toMatch(/transcription_method\s+text/i);
    expect(canonical).toMatch(/dispatch_humanize\s+boolean/i);
    expect(canonical).toMatch(/dispatch_media_url\s+text/i);
    expect(canonical).toMatch(/humanize_messages\s+boolean/i);
    expect(canonical).toMatch(/source_status\s+text/i);
    expect(canonical).toMatch(/contacts_client_remote_jid_key[\s\S]*unique\s*\(client_id, remote_jid\)/i);
    expect(canonical).toMatch(/messages_client_message_id_key[\s\S]*unique\s*\(client_id, message_id\)/i);
    expect(canonical).toMatch(/chats_dashboard_client_message_id_key[\s\S]*unique\s*\(client_id, message_id\)/i);
    expect(canonical).toMatch(/revoke all on table public\.clients from anon, authenticated/i);
    expect(canonical).toMatch(/alter table public\.auth_sessions enable row level security/i);
  });

  it("falha sem a migration e preserva eventual saída existente", () => {
    const cwd = makeTempProject();
    const outputDir = join(cwd, "src", "lib");
    const outputPath = join(outputDir, "setup-sql.ts");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(outputPath, "ARTEFATO_ANTIGO", "utf8");

    const result = spawnSync(process.execPath, [scriptPath], { cwd, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("migrations/SETUP_COMPLETO.sql não encontrado");
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, "utf8")).toBe("ARTEFATO_ANTIGO");
  });
});
