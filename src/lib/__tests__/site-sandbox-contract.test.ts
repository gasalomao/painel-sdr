import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { getStarterFiles } from "@/lib/sites/starter";

const source = readFileSync("sandbox/site-studio/template.mjs", "utf8");

async function templateContract(env: Record<string, string> = {}) {
  const commands: Array<{ workdir: string; command: string }> = [];
  let workdir = "";
  const template = {
    fromImage: vi.fn().mockReturnThis(),
    setUser: vi.fn().mockReturnThis(),
    setWorkdir(path: string) { workdir = path; return template; },
    runCmd(command: string) { commands.push({ workdir, command }); return template; },
  };
  const Template = Object.assign(vi.fn(() => template), { build: vi.fn().mockResolvedValue({ templateId: "test", buildId: "test" }) });
  const execute = () => runInNewContext(`(async () => { ${source.replace(/^import .*;\r?\n/gm, "")} })()`, {
    Template, getStarterFiles, Buffer, process: { env }, console: { log: vi.fn() },
  }) as Promise<void>;
  return { commands, template, Template, execute };
}

function decodedFile(commands: Array<{ command: string }>, path: string): string {
  const command = commands.find((entry) => entry.command.endsWith(` > ${path}`))?.command;
  const encoded = command?.match(/^printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > /)?.[1];
  expect(encoded).toBeDefined();
  return Buffer.from(encoded!, "base64").toString("utf8");
}

describe("contrato offline do template E2B", () => {
  it.each<Record<string, string>>([{}, { E2B_API_KEY: "test" }, { SITE_STUDIO_PROVISION: "1" }])("não provisiona sem opt-in e credencial: %j", async (env) => {
    const contract = await templateContract(env);
    await expect(contract.execute()).rejects.toThrow();
    expect(contract.Template).not.toHaveBeenCalled();
    expect(contract.Template.build).not.toHaveBeenCalled();
  });

  it("instala devDependencies fixas apesar de omit=dev sem scripts npm", async () => {
    const contract = await templateContract({ SITE_STUDIO_PROVISION: "1", E2B_API_KEY: "test" });
    await contract.execute();
    const install = contract.commands.find(({ workdir, command }) => workdir === "/opt/site-deps" && command.startsWith("npm install"));
    expect(install?.command.split(/\s+/)).toEqual(expect.arrayContaining(["--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"]));
    expect(decodedFile(contract.commands, "/opt/site-deps/.npmrc")).toContain("save-exact=true");
    const starter = getStarterFiles();
    const packageContent = decodedFile(contract.commands, "/opt/site-deps/package.json");
    expect(packageContent).toBe(starter["package.json"]);
    const pkg = JSON.parse(packageContent) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.devDependencies).toHaveProperty("typescript");
    expect(pkg.devDependencies).toHaveProperty("vite");
    for (const version of Object.values({ ...pkg.dependencies, ...pkg.devDependencies })) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const fixed = JSON.parse(decodedFile(contract.commands, "/opt/site-studio/fixed.json"));
    expect(fixed).toEqual(Object.fromEntries(Object.entries(starter).filter(([path]) => path !== "index.html" && !path.startsWith("src/") && !path.startsWith("public/"))));
    expect(contract.commands.find(({ command }) => command.includes("playwright@"))?.command).toBe("npm install --ignore-scripts --save-exact --no-audit --no-fund playwright@1.58.2");
    expect(contract.template.fromImage).toHaveBeenCalledWith(expect.stringMatching(/^node:22-bookworm@sha256:[a-f0-9]{64}$/));
    expect(contract.Template.build).toHaveBeenCalledTimes(1);
  });
});
