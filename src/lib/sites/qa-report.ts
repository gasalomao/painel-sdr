import type { WebsiteBuildResult, WebsiteQa } from "./types";

export interface WebsiteQaReport {
  readonly status: "failed";
  readonly technicalSuccess: boolean;
  readonly durationMs: number;
  readonly logs: string;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly diagnostics: readonly string[];
  readonly modelUsed: string | null;
  readonly workspaceVersion: string;
  readonly truncated: boolean;
  readonly failureKind?: WebsiteQa["failure_kind"];
  readonly stage?: string;
  readonly visualReview?: string;
}

const MAX_LOG_CHARS = 16_000;
const MAX_ITEMS = 20;
const MAX_ITEM_CHARS = 2000;
const MAX_REVIEW_CHARS = 3000;
const REPORT_KEYS = ["status", "technicalSuccess", "durationMs", "logs", "errors", "warnings", "diagnostics", "modelUsed", "workspaceVersion", "truncated", "failureKind", "stage", "visualReview"];

export function websiteQaReport(build: WebsiteBuildResult, modelUsed: string | null, workspaceVersion: string): WebsiteQaReport {
  const errors = [...build.errors, ...build.qa.errors];
  const warnings = [...build.warnings, ...build.qa.warnings];
  const diagnostics = build.qa.diagnostics ?? [];
  const bounded = (items: string[]): string[] => items.slice(0, MAX_ITEMS).map((item) => item.slice(0, MAX_ITEM_CHARS));
  // ponytail: retain diagnostic evidence only; binary artifacts/screenshots need a dedicated failed-build record.
  const report: WebsiteQaReport = {
    status: "failed", technicalSuccess: build.success, durationMs: build.duration_ms,
    logs: build.logs.slice(0, MAX_LOG_CHARS), errors: bounded(errors), warnings: bounded(warnings), diagnostics: bounded(diagnostics),
    modelUsed, workspaceVersion,
    truncated: build.logs.length > MAX_LOG_CHARS || (build.qa.visual_review?.length ?? 0) > MAX_REVIEW_CHARS
      || [errors, warnings, diagnostics].some((items) => items.length > MAX_ITEMS || items.some((item) => item.length > MAX_ITEM_CHARS)),
    ...(build.qa.failure_kind !== undefined ? { failureKind: build.qa.failure_kind } : {}),
    ...(build.qa.stage !== undefined ? { stage: build.qa.stage } : {}),
    ...(build.qa.visual_review !== undefined ? { visualReview: build.qa.visual_review.slice(0, MAX_REVIEW_CHARS) } : {}),
  };
  validateWebsiteQaReport(report);
  return report;
}

export function validateWebsiteQaReport(value: unknown): asserts value is WebsiteQaReport | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Relatório QA do checkpoint inválido.");
  const report = value as Record<string, unknown>;
  const strings = (items: unknown): boolean => Array.isArray(items) && items.length <= MAX_ITEMS && Array.from(items).every((item) => typeof item === "string" && item.length <= MAX_ITEM_CHARS);
  if (Object.keys(report).some((key) => !REPORT_KEYS.includes(key))
    || report.status !== "failed" || typeof report.technicalSuccess !== "boolean" || typeof report.truncated !== "boolean"
    || typeof report.durationMs !== "number" || !Number.isSafeInteger(report.durationMs) || report.durationMs < 0
    || typeof report.logs !== "string" || report.logs.length > MAX_LOG_CHARS
    || !strings(report.errors) || !strings(report.warnings) || !strings(report.diagnostics)
    || !(report.modelUsed === null || typeof report.modelUsed === "string" && report.modelUsed.length <= 200)
    || typeof report.workspaceVersion !== "string" || !/^[a-f0-9]{64}$/.test(report.workspaceVersion)
    || report.failureKind !== undefined && (typeof report.failureKind !== "string" || !["source", "infrastructure", "timeout", "cancelled"].includes(report.failureKind))
    || report.stage !== undefined && (typeof report.stage !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(report.stage))
    || report.visualReview !== undefined && (typeof report.visualReview !== "string" || report.visualReview.length > MAX_REVIEW_CHARS)) {
    throw new Error("Relatório QA do checkpoint inválido.");
  }
}
