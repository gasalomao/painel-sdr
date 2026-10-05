import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { supabaseAdmin } from "@/lib/supabase";
import { siteAssetPublicPath } from "./asset-preview";
import { getStarterFiles } from "./starter";
import { validateFiles, validateWebsiteContent } from "./validation";
import type { WebsiteAsset, WebsiteBuildResult, WebsiteFiles, WebsiteProject } from "./types";

export const SITE_PROVIDER_NOT_CONFIGURED = "READY — AWAITING CREDENTIALS";
const TIMEOUT_MS = 180_000;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

export interface SiteBuildProvider {
  build(input: { project: WebsiteProject; files: WebsiteFiles; assets: WebsiteAsset[] }, signal?: AbortSignal): Promise<WebsiteBuildResult>;
}

function failed(message: string, started: number, status: "failed" | "unconfigured" = "failed"): WebsiteBuildResult {
  return { success: false, status, logs: "", duration_ms: Date.now() - started, artifact: {}, errors: [message], warnings: [], screenshots: {}, qa: { passed: false, errors: [message], warnings: [] } };
}

async function downloadAssets(project: WebsiteProject, assets: WebsiteAsset[], signal?: AbortSignal): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  let total = 0;
  for (const asset of assets) {
    signal?.throwIfAborted();
    if (asset.client_id !== project.client_id || asset.project_id !== project.id ||
      !asset.path.startsWith(`${project.client_id}/${project.id}/`) ||
      asset.path.split("/").some((part) => !part || part === "." || part === "..") ||
      /[\\%\x00-\x1f]/.test(asset.path) || asset.size < 1 || asset.size > MAX_ASSET_BYTES) {
      throw new Error("Asset fora do escopo do projeto.");
    }
    if (asset.purpose === "reference") continue;
    const target = `public${siteAssetPublicPath(asset)}`;
    if (!supabaseAdmin) throw new Error(SITE_PROVIDER_NOT_CONFIGURED);
    const { data, error } = await supabaseAdmin.storage.from("website-assets").download(asset.path);
    if (error || !data || data.size !== asset.size) throw new Error("Falha ao baixar asset privado.");
    total += data.size;
    if (total > MAX_TOTAL_BYTES) throw new Error("Assets excedem o limite do build.");
    result[target] = Buffer.from(await data.arrayBuffer()).toString("base64");
  }
  return result;
}

export function createSiteBuildProvider(): SiteBuildProvider {
  return {
    async build({ project, files, assets }, signal) {
      const started = Date.now();
      const apiKey = process.env.E2B_API_KEY;
      const template = process.env.E2B_SITE_TEMPLATE_ID;
      if (!apiKey || !template) return failed(SITE_PROVIDER_NOT_CONFIGURED, started, "unconfigured");
      let sandbox: Awaited<ReturnType<typeof import("e2b").Sandbox.create>> | undefined;
      let killPromise: Promise<unknown> | undefined;
      const kill = () => { if (sandbox) killPromise ??= sandbox.kill(); return killPromise; };
      const onAbort = () => { void kill()?.catch(() => undefined); };
      try {
        signal?.throwIfAborted();
        validateFiles(files);
        const sourceQa = validateWebsiteContent(files);
        if (!sourceQa.passed) return failed(sourceQa.errors.join("\n"), started);
        if (!project.current_revision_id) throw new Error("Salve uma revisão antes de compilar.");
        const starter = getStarterFiles();
        for (const [path, content] of Object.entries(files)) {
          if (path !== "index.html" && !path.startsWith("src/") && !path.startsWith("public/")) {
            if (starter[path] !== content) throw new Error("Configuração imutável alterada.");
          }
          if (path.startsWith("public/assets/")) throw new Error("Assets são reservados ao armazenamento privado.");
        }
        const binaries = await downloadAssets(project, assets, signal);
        const runner = await readFile(join(process.cwd(), "sandbox/site-studio/run.mjs"), "utf8");
        const { Sandbox } = await import("e2b");
        sandbox = await Sandbox.create(template, {
          apiKey, timeoutMs: TIMEOUT_MS, allowInternetAccess: false,
          network: { allowPublicTraffic: false },
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        signal?.throwIfAborted();
        await sandbox.files.write("/opt/site-studio/run.mjs", runner, { user: "root" });
        await sandbox.files.write("/workspace/input.json", JSON.stringify({ files: { ...starter, ...files }, binaries }), { user: "studio" });
        await sandbox.commands.run("env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/studio PLAYWRIGHT_BROWSERS_PATH=/opt/browsers node /opt/site-studio/run.mjs", { user: "studio", timeoutMs: TIMEOUT_MS - 15_000 });
        signal?.throwIfAborted();
        const raw = await sandbox.files.read("/workspace/result.json");
        if (Buffer.byteLength(raw) > 80 * 1024 * 1024) throw new Error("Resultado excede o limite.");
        const result = JSON.parse(raw) as WebsiteBuildResult;
        if (!result || typeof result.success !== "boolean" || !Array.isArray(result.errors) ||
          !Array.isArray(result.warnings) || !result.qa || !Array.isArray(result.qa.errors) ||
          !Array.isArray(result.qa.warnings) || !result.artifact || !result.screenshots) throw new Error("Resultado de QA inválido.");
        const passed = result.success && result.qa.passed && !result.errors.length && !result.qa.errors.length &&
          Boolean(result.screenshots.desktop?.startsWith("data:image/png;base64,iVBOR")) &&
          Boolean(result.screenshots.mobile?.startsWith("data:image/png;base64,iVBOR")) && Boolean(result.artifact["/index.html"]);
        return { ...result, success: passed, status: passed ? "ready" : "failed", duration_ms: Date.now() - started,
          qa: { passed, errors: result.qa.errors, warnings: result.qa.warnings } };
      } catch {
        return failed(signal?.aborted ? "Build cancelado." : "Build isolado falhou. Verifique template, arquivos e assets.", started);
      } finally {
        signal?.removeEventListener("abort", onAbort);
        await kill()?.catch(() => undefined);
      }
    },
  };
}
