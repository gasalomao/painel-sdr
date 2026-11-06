import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runOpenCodeHeadless, type OpenCodeRunResult } from "./opencode-runner";
import { detectImpeccableAntiPatterns, type ImpeccableDetectResult } from "./impeccable-detector";
import { inspectLocalHtmlGeometry } from "./qa-inspector";
import {
  buildQualityCorrectionPrompt,
  scanHtmlStatic,
  summarizeDetectorFindings,
  type QualityViolation,
} from "./site-quality-gate";

export interface GenerateSiteOptions {
  workspaceDir: string;
  leadName?: string;
  niche?: string;
  /** Tentativas extras de correção. Default: 3 (env SITE_QA_MAX_LOOPS). */
  maxLoops?: number;
  timeoutMs?: number;
  onLog?: (line: string) => void;
}

export interface SiteQualityEvaluation {
  violations: QualityViolation[];
  detector: ImpeccableDetectResult;
  cssValid: boolean;
  geometryPassed: boolean;
}

export interface GenerateSiteResult {
  success: boolean;
  /** Total de execuções do OpenCode (1 geração + N correções). */
  attempts: number;
  violations: QualityViolation[];
  detector?: ImpeccableDetectResult;
  run: OpenCodeRunResult;
}

async function countPhotos(workspaceDir: string): Promise<number> {
  try {
    const files = await fs.readdir(path.join(workspaceDir, "fotos"));
    return files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).length;
  } catch {
    return 0;
  }
}

/**
 * Camadas 1 + 2 + 3 sobre o index.html local (antes de qualquer deploy):
 * detector oficial, scanner estático (sintaxe CSS + movimento) e geometria real.
 */
export async function evaluateSiteQuality(workspaceDir: string): Promise<SiteQualityEvaluation> {
  const htmlPath = path.join(workspaceDir, "index.html");
  const photosCount = await countPhotos(workspaceDir);

  let html: string;
  try {
    html = await fs.readFile(htmlPath, "utf-8");
  } catch {
    return {
      violations: [{ code: "missing-index-html", message: "index.html não foi gerado no workspace." }],
      detector: {
        clean: false,
        issuesCount: 1,
        blockingIssues: 1,
        issues: ["missing-index-html"],
        rawOutput: "index.html ausente",
      },
      cssValid: false,
      geometryPassed: false,
    };
  }

  const detector = await detectImpeccableAntiPatterns(htmlPath);
  const staticViolations = scanHtmlStatic(html, { requirePhotos: photosCount > 0 });

  const audits = await inspectLocalHtmlGeometry(htmlPath);
  const geometryViolations: QualityViolation[] = audits.flatMap((audit) =>
    audit.violations.map((violation) => ({
      code: `geometry-${audit.viewport}-${violation.code}`,
      message: `[${audit.viewport}] ${violation.message}`,
    }))
  );

  const detectorDetails = summarizeDetectorFindings(detector.rawOutput);
  const detectorViolations: QualityViolation[] = detector.blockingIssues > 0
    ? [
        {
          code: "impeccable-detector",
          message: `Detector oficial Impeccable: ${detector.issuesCount} anti-pattern(s) — ${detector.issues.join(", ")}${detectorDetails ? `\n${detectorDetails}` : ""}`,
        },
      ]
    : [];

  return {
    violations: [...detectorViolations, ...staticViolations, ...geometryViolations],
    detector,
    cssValid: !staticViolations.some((v) => v.code === "css-invalid"),
    geometryPassed: geometryViolations.length === 0,
  };
}

/**
 * Gera o site e, se o gate reprovar, reexecuta o OpenCode com a lista de
 * violações antes de liberar o deploy. Deploy só acontece com `success: true`.
 */
export async function generateSiteWithAutoCorrection(
  opts: GenerateSiteOptions
): Promise<GenerateSiteResult> {
  const envLoops = Number.parseInt(process.env.SITE_QA_MAX_LOOPS || "", 10);
  const maxLoops = Math.max(0, opts.maxLoops ?? (Number.isFinite(envLoops) ? envLoops : 3));

  const runOnce = (additionalPrompt?: string) =>
    runOpenCodeHeadless({
      workspaceDir: opts.workspaceDir,
      leadName: opts.leadName,
      niche: opts.niche,
      timeoutMs: opts.timeoutMs ?? 1_500_000,
      additionalPrompt,
      onLog: opts.onLog,
    });

  let attempts = 1;
  let run = await runOnce();

  if (!run.success) {
    return { success: false, attempts, violations: [], run };
  }

  let evaluation = await evaluateSiteQuality(opts.workspaceDir);

  while (evaluation.violations.length > 0 && attempts <= maxLoops) {
    opts.onLog?.(
      `[Quality Gate] 🔁 Tentativa ${attempts}/${maxLoops} de correção — ${evaluation.violations.length} violação(ões): ${evaluation.violations.map((v) => v.code).join(", ")}`
    );

    run = await runOnce(buildQualityCorrectionPrompt(evaluation.violations, attempts, maxLoops));
    attempts += 1;

    if (!run.success) break;
    evaluation = await evaluateSiteQuality(opts.workspaceDir);
  }

  if (evaluation.violations.length === 0) {
    opts.onLog?.(`[Quality Gate] ✅ Aprovado em ${attempts} execução(ões): CSS válido, geometria Desktop/Mobile e movimento OK.`);
  } else {
    opts.onLog?.(
      `[Quality Gate] ❌ Reprovado após ${attempts} execução(ões): ${evaluation.violations.map((v) => `[${v.code}] ${v.message}`).join(" | ")}`
    );
  }

  return {
    success: evaluation.violations.length === 0,
    attempts,
    violations: evaluation.violations,
    detector: evaluation.detector,
    run,
  };
}

/**
 * Corrige um site JÁ EXISTENTE no workspace até o gate passar.
 * Usado quando a geração terminou (ou estourou o tempo) mas o gate reprovou:
 * o agente edita o index.html existente em vez de regenerar do zero.
 */
export async function correctSiteQuality(opts: {
  workspaceDir: string;
  leadName?: string;
  niche?: string;
  maxLoops?: number;
  timeoutMs?: number;
  onLog?: (line: string) => void;
}): Promise<{
  success: boolean;
  attempts: number;
  violations: QualityViolation[];
  detector?: Awaited<ReturnType<typeof evaluateSiteQuality>>["detector"];
  run?: Awaited<ReturnType<typeof runOpenCodeHeadless>>;
}> {
  const envLoops = Number.parseInt(process.env.SITE_QA_MAX_LOOPS || "", 10);
  const maxLoops = Math.max(1, opts.maxLoops ?? (Number.isFinite(envLoops) ? envLoops : 3));

  let evaluation = await evaluateSiteQuality(opts.workspaceDir);
  let attempts = 0;
  let run: Awaited<ReturnType<typeof runOpenCodeHeadless>> | undefined;

  while (evaluation.violations.length > 0 && attempts < maxLoops) {
    attempts += 1;
    opts.onLog?.(
      `[Quality Gate] 🔧 Correção ${attempts}/${maxLoops} — ${evaluation.violations.length} violação(ões): ${evaluation.violations.map((v) => v.code).join(", ")}`
    );

    const summary = evaluation.violations
      .map((v) => `[${v.code}] ${v.message}`)
      .join("\n\n");

    run = await runOpenCodeHeadless({
      workspaceDir: opts.workspaceDir,
      leadName: opts.leadName,
      mode: "repair",
      timeoutMs: opts.timeoutMs ?? 600_000,
      additionalPrompt: summary,
      onLog: opts.onLog,
    });

    if (!run.success) break;
    evaluation = await evaluateSiteQuality(opts.workspaceDir);
  }

  if (evaluation.violations.length === 0) {
    opts.onLog?.(`[Quality Gate] ✅ Aprovado após ${attempts} correção(ões).`);
  } else {
    opts.onLog?.(
      `[Quality Gate] ❌ Reprovado após ${attempts} correção(ões): ${evaluation.violations.map((v) => `[${v.code}] ${v.message}`).join(" | ")}`
    );
  }

  return {
    success: evaluation.violations.length === 0,
    attempts,
    violations: evaluation.violations,
    detector: evaluation.detector,
    run,
  };
}
