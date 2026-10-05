import { Template } from "e2b";
import { getStarterFiles } from "../../src/lib/sites/starter.ts";

if (process.env.SITE_STUDIO_PROVISION !== "1") throw new Error("Defina SITE_STUDIO_PROVISION=1 para provisionar o template remoto.");
if (!process.env.E2B_API_KEY) throw new Error("READY — AWAITING CREDENTIALS");
const starter = getStarterFiles();
const fixed = Object.fromEntries(Object.entries(starter).filter(([path]) => path !== "index.html" && !path.startsWith("src/") && !path.startsWith("public/")));
if (!fixed["package.json"] || !fixed["tsconfig.json"] || !Object.keys(fixed).some((path) => path.startsWith("vite.config."))) throw new Error("Starter técnico incompleto.");
const packageContent = Buffer.from(fixed["package.json"]).toString("base64");
const fixedContent = Buffer.from(JSON.stringify(fixed)).toString("base64");
const PINNED_NPMRC = "registry=https://registry.npmjs.org/\nsave-exact=true\nomit=dev\n";
const template = Template()
  .fromImage("node:22-bookworm@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d")
  .setUser("root")
  .runCmd("useradd --create-home --shell /bin/bash studio && mkdir -p /opt/site-studio /opt/site-deps /workspace && chown studio:studio /workspace")
  .runCmd(`printf '%s' '${Buffer.from(PINNED_NPMRC).toString("base64")}' | base64 -d > /opt/site-deps/.npmrc`)
  .runCmd(`printf '%s' '${packageContent}' | base64 -d > /opt/site-deps/package.json`)
  .runCmd(`printf '%s' '${fixedContent}' | base64 -d > /opt/site-studio/fixed.json`)
  .setWorkdir("/opt/site-deps")
  .runCmd("npm install --include=dev --ignore-scripts --no-audit --no-fund")
  .setWorkdir("/opt/site-studio")
  .runCmd("npm install --ignore-scripts --save-exact --no-audit --no-fund playwright@1.58.2")
  .runCmd("PLAYWRIGHT_BROWSERS_PATH=/opt/browsers node node_modules/playwright/cli.js install --with-deps chromium")
  .runCmd("chmod -R a+rX,go-w /opt/site-studio /opt/site-deps /opt/browsers")
  .setWorkdir("/workspace")
  .setUser("studio");
const result = await Template.build(template, "site-studio-v1", { cpuCount: 2, memoryMB: 2048 });
console.log(JSON.stringify({ templateId: result.templateId, buildId: result.buildId }));
