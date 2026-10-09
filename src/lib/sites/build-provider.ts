import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { supabaseAdmin } from "@/lib/supabase";
import { siteAssetPublicPath } from "./asset-preview";
import { getStarterFiles } from "./starter";
import { validateFiles, validateWebsiteContent } from "./validation";
import type { WebsiteAsset, WebsiteBuildResult, WebsiteFiles, WebsiteProject, WebsiteQa } from "./types";

export const SITE_PROVIDER_NOT_CONFIGURED = "READY — AWAITING CREDENTIALS";
const TOTAL_MS = 60_000;
const CLEANUP_MS = 5_000;
const COMMAND_MS = 45_000;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
type FailureKind = NonNullable<WebsiteQa["failure_kind"]>;

export interface SiteBuildProvider {
  build(input: { project: WebsiteProject; files: WebsiteFiles; assets: WebsiteAsset[] }, signal?: AbortSignal): Promise<WebsiteBuildResult>;
}

function safeDiagnostic(text: string): string {
  return text.slice(0, 4000).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f​-‏‪-‮⁠-⁯]/g, " ")
    .replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(/\b(?:token|password|secret|api[_-]?key|authorization)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\b(?:sk-|eyJ)[\w.-]+/g, "[redacted]")
    .replace(/(['"`])[^'"`]*\1/g, "[quoted]").slice(0, 300);
}

function failed(message: string, started: number, kind: FailureKind, stage: string, status: "failed" | "unconfigured" = "failed"): WebsiteBuildResult {
  const error = safeDiagnostic(message);
  return { success: false, status, logs: "", duration_ms: Date.now() - started, artifact: {}, errors: [error], warnings: [], screenshots: {},
    qa: { passed: false, errors: [error], warnings: [], failure_kind: kind, stage, diagnostics: [] } };
}

async function downloadAssets(project: WebsiteProject, assets: WebsiteAsset[], signal: AbortSignal): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  let total = 0;
  for (const asset of assets) {
    signal.throwIfAborted();
    if (asset.client_id !== project.client_id || asset.project_id !== project.id ||
      !asset.path.startsWith(`${project.client_id}/${project.id}/`) ||
      asset.path.split("/").some((part) => !part || part === "." || part === "..") ||
      /[\\%\x00-\x1f]/.test(asset.path) || !Number.isFinite(asset.size) || asset.size < 1 || asset.size > MAX_ASSET_BYTES) {
      throw new Error("Asset fora do escopo do projeto.");
    }
    if (asset.purpose === "reference") continue;
    const target = `public${siteAssetPublicPath(asset)}`;
    if (!supabaseAdmin) throw new Error(SITE_PROVIDER_NOT_CONFIGURED);
    const { data, error } = await supabaseAdmin.storage.from("website-assets").download(asset.path);
    signal.throwIfAborted();
    if (error || !data || data.size !== asset.size) throw new Error("Falha ao baixar asset privado.");
    total += data.size;
    if (total > MAX_TOTAL_BYTES) throw new Error("Assets excedem o limite do build.");
    result[target] = Buffer.from(await data.arrayBuffer()).toString("base64");
  }
  return result;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 200 && value.every((item) => typeof item === "string" && item.length <= 1000);
}

function parseResult(raw: string, started: number): WebsiteBuildResult {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 80 * 1024 * 1024) throw new Error("Resultado excede o limite.");
  const value: unknown = JSON.parse(raw);
  if (!object(value) || typeof value.success !== "boolean" || !strings(value.errors) || !strings(value.warnings) ||
    !object(value.qa) || typeof value.qa.passed !== "boolean" || !strings(value.qa.errors) || !strings(value.qa.warnings) ||
    !object(value.artifact) || !object(value.screenshots)) throw new Error("Resultado de QA inválido.");
  const result = value as unknown as WebsiteBuildResult;
  const passed = result.success && result.qa.passed && !result.errors.length && !result.qa.errors.length;
  if (passed && result.qa.failure_kind !== undefined) throw new Error("QA contraditório.");
  if (passed && (!result.screenshots.desktop?.startsWith("data:image/png;base64,iVBOR") ||
    !result.screenshots.mobile?.startsWith("data:image/png;base64,iVBOR") || !object(result.artifact["/index.html"]))) throw new Error("Evidência de QA ausente.");
  if (Object.values(result.screenshots).some((image) => typeof image !== "string") ||
    Object.values(result.artifact).some((file) => !object(file) || typeof file.content !== "string" || typeof file.mime !== "string")) throw new Error("Artefato inválido.");
  const kind = result.qa.failure_kind;
  const failureKind: FailureKind = kind && ["source", "infrastructure", "timeout", "cancelled"].includes(kind) ? kind : "infrastructure";
  const errors = result.errors.slice(0, 8).map(safeDiagnostic), warnings = result.warnings.slice(0, 8).map(safeDiagnostic);
  const qaErrors = result.qa.errors.slice(0, 8).map(safeDiagnostic);
  if (!passed && !errors.length && !qaErrors.length) throw new Error("Falha sem diagnóstico.");
  const diagnostics = strings(result.qa.diagnostics) ? result.qa.diagnostics.slice(0, 8).map(safeDiagnostic) : [];
  const stage = typeof result.qa.stage === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(result.qa.stage) ? result.qa.stage : "render";
  return { success: passed, status: passed ? "ready" : "failed", logs: "", duration_ms: Date.now() - started,
    artifact: result.artifact, screenshots: result.screenshots, errors, warnings,
    qa: { passed, errors: qaErrors, warnings: result.qa.warnings.slice(0, 8).map(safeDiagnostic),
      ...(passed ? {} : { failure_kind: failureKind, stage, diagnostics }) } };
}

export function createSiteBuildProvider(): SiteBuildProvider {
  return {
    async build({ project, files, assets }, signal) {
      const started = Date.now(), deadline = started + TOTAL_MS - CLEANUP_MS;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new DOMException("Build deadline", "TimeoutError")), TOTAL_MS - CLEANUP_MS);
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let stage = "configuration", kind: FailureKind = "infrastructure";
      let sandbox: Awaited<ReturnType<typeof import("e2b").Sandbox.create>> | undefined;
      let killPromise: Promise<unknown> | undefined;
      const kill = (): Promise<unknown> | undefined => {
        if (sandbox) killPromise ??= Promise.resolve().then(() => sandbox!.kill());
        return killPromise;
      };
      const onAbort = (): void => { void kill()?.catch(() => undefined); };
      combined.addEventListener("abort", onAbort, { once: true });
      const bounded = async <T>(operation: Promise<T>): Promise<T> => {
        combined.throwIfAborted();
        let abort: (() => void) | undefined;
        try {
          const value = await Promise.race([operation, new Promise<never>((_, reject) => {
            abort = () => reject(combined.reason);
            combined.addEventListener("abort", abort, { once: true });
            if (combined.aborted) abort();
          })]);
          combined.throwIfAborted();
          return value;
        } finally { if (abort) combined.removeEventListener("abort", abort); }
      };
      const result = await (async (): Promise<WebsiteBuildResult> => {
      try {
        combined.throwIfAborted();
        let apiKey = process.env.E2B_API_KEY?.trim(), template = process.env.E2B_SITE_TEMPLATE_ID?.trim();
        // Preserve the original checkout's worker credential reload; tests never load local secrets.
        if (process.env.NODE_ENV !== "test" && (!apiKey || !template)) {
          const dotenv = await bounded(import("dotenv"));
          dotenv.config({ path: join(process.cwd(), ".env.local"), override: true });
          combined.throwIfAborted();
          apiKey = process.env.E2B_API_KEY?.trim(); template = process.env.E2B_SITE_TEMPLATE_ID?.trim();
        }
        if (!apiKey || !template) return failed(SITE_PROVIDER_NOT_CONFIGURED, started, kind, stage, "unconfigured");
        stage = "validation"; kind = "source";
        validateFiles(files);
        const sourceQa = validateWebsiteContent(files);
        if (!sourceQa.passed) return failed(sourceQa.errors.slice(0, 4).join("; "), started, kind, stage);
        kind = "infrastructure";
        if (!project.current_revision_id) throw new Error("Salve uma revisão antes de compilar.");
        stage = "assets";
        const binaries = await bounded(downloadAssets(project, assets, combined));
        stage = "runner";
        const runner = await bounded(readFile(join(process.cwd(), "sandbox/site-studio/run.mjs"), "utf8"));
        const { Sandbox } = await bounded(import("e2b"));
        stage = "sandbox";
        const creation = Sandbox.create(template, {
          apiKey, timeoutMs: TOTAL_MS, allowInternetAccess: false, network: { allowPublicTraffic: false },
        }).then((created) => {
          sandbox = created;
          if (combined.aborted) {
            void created.kill?.();
          }
          return created;
        });
        await bounded(creation);
        stage = "input";
        await bounded(sandbox!.files.write("/opt/site-studio/run.mjs", runner, { user: "root" }));
        await bounded(sandbox!.files.write("/workspace/input.json", JSON.stringify({ files: { ...getStarterFiles(), ...files }, binaries }), { user: "studio" }));
        stage = "command";
        const commandMs = Math.min(COMMAND_MS, deadline - Date.now() - CLEANUP_MS);
        if (commandMs <= 3000) throw new DOMException("Build deadline", "TimeoutError");
        await bounded(sandbox!.commands.run(`env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/studio PLAYWRIGHT_BROWSERS_PATH=/opt/browsers SITE_STUDIO_RUNNER_BUDGET_MS=${commandMs - 3000} node /opt/site-studio/run.mjs`, { user: "studio", timeoutMs: commandMs }));
        stage = "result";
        const raw = await bounded(sandbox!.files.read("/workspace/result.json"));
        return parseResult(raw, started);
      } catch (error) {
        const failure: FailureKind = signal?.aborted ? "cancelled" : controller.signal.aborted ||
          (error instanceof Error && /timeout/i.test(error.name)) ? "timeout" : kind;
        const message = failure === "cancelled" ? "Build cancelado." : failure === "timeout" ? `Tempo de build esgotado (${stage}).` :
          failure === "source" && error instanceof Error ? error.message : `Infraestrutura do build isolado indisponível (${stage}).`;
        return failed(message, started, failure, stage);
      }
      })();
      clearTimeout(timeout);
      combined.removeEventListener("abort", onAbort);
      let cleanup: ReturnType<typeof setTimeout> | undefined;
      try {
        const cleanupOk = await Promise.race([kill()?.then(() => true, () => false) ?? Promise.resolve(true),
          new Promise<boolean>((done) => { cleanup = setTimeout(() => done(false), CLEANUP_MS); })]);
        if (!cleanupOk) return failed(signal?.aborted ? "Build cancelado; encerramento pendente." : "Encerramento do sandbox não confirmado.", started,
          signal?.aborted ? "cancelled" : "infrastructure", "cleanup");
        if (signal?.aborted) return failed("Build cancelado.", started, "cancelled", stage);
        return result;
      } finally { if (cleanup) clearTimeout(cleanup); }
    },
  };
}
