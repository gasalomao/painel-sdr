import { describe, expect, it } from "vitest";
import { validateWebsiteQaReport, websiteQaReport, type WebsiteQaReport } from "../qa-report";
import type { WebsiteBuildResult } from "../types";

const build: WebsiteBuildResult = {
  status: "failed", success: false, logs: "Build interrompido", duration_ms: 100,
  artifact: { "/index.html": { content: "binary", mime: "text/html" } }, screenshots: { desktop: "data:image/png;base64,private" },
  errors: ["Build error"], warnings: ["Build warning"],
  qa: { passed: false, errors: ["QA error"], warnings: ["QA warning"], failure_kind: "source", stage: "compile", diagnostics: ["src/App.tsx(1,1)"], visual_review: "Reprovado." },
};
const version = "a".repeat(64);
const valid = (): WebsiteQaReport => websiteQaReport(build, "vendor/model", version);

describe("private checkpoint QA evidence", () => {
  it("retains diagnostic evidence without binaries or mutation", () => {
    const original = structuredClone(build);
    const report = valid();
    expect(report).toEqual({ status: "failed", technicalSuccess: false, durationMs: 100, logs: "Build interrompido", errors: ["Build error", "QA error"], warnings: ["Build warning", "QA warning"], diagnostics: ["src/App.tsx(1,1)"], modelUsed: "vendor/model", workspaceVersion: version, truncated: false, failureKind: "source", stage: "compile", visualReview: "Reprovado." });
    expect(report).not.toHaveProperty("artifact");
    expect(report).not.toHaveProperty("screenshots");
    expect(build).toEqual(original);
  });

  it("bounds large diagnostics and explicitly records truncation", () => {
    const report = websiteQaReport({ ...build, logs: "x".repeat(16001), errors: Array(21).fill("x".repeat(2001)), qa: { ...build.qa, visual_review: "x".repeat(3001) } }, null, version);
    expect(report.logs).toHaveLength(16000);
    expect(report.errors).toHaveLength(20);
    expect(report.errors[0]).toHaveLength(2000);
    expect(report.visualReview).toHaveLength(3000);
    expect(report.truncated).toBe(true);
    expect(() => validateWebsiteQaReport(report)).not.toThrow();
  });

  it("accepts exact limits and legacy absence, omitting unavailable metadata", () => {
    expect(() => validateWebsiteQaReport(undefined)).not.toThrow();
    const report = websiteQaReport({ ...build, logs: "x".repeat(16000), errors: Array(20).fill("x".repeat(2000)), qa: { passed: false, errors: [], warnings: [] } }, null, version);
    expect(report.truncated).toBe(false);
    expect(report).not.toHaveProperty("failureKind");
    expect(report).not.toHaveProperty("stage");
    expect(report).not.toHaveProperty("visualReview");
    expect(() => validateWebsiteQaReport({ ...report, modelUsed: "x".repeat(200), stage: "x".repeat(40), visualReview: "x".repeat(3000) })).not.toThrow();
  });

  it.each([
    null, [], { status: "ready" }, { technicalSuccess: 1 }, { durationMs: -1 }, { durationMs: 0.5 }, { durationMs: Number.MAX_SAFE_INTEGER + 1 },
    { logs: null }, { logs: "x".repeat(16001) }, { errors: "error" }, { errors: Array(21).fill("error") }, { errors: [1] }, { warnings: ["x".repeat(2001)] },
    { diagnostics: null }, { errors: Array(1) }, { modelUsed: "x".repeat(201) }, { modelUsed: 1 }, { workspaceVersion: "invalid" }, { workspaceVersion: null },
    { truncated: null }, { failureKind: "invalid" }, { failureKind: null }, { stage: "Bad stage" }, { stage: "x".repeat(41) }, { stage: null },
    { visualReview: "x".repeat(3001) }, { visualReview: null }, { artifact: {} }, { screenshots: {} },
  ])("rejects invalid evidence patch %#", (patch) => {
    const report = patch === null || Array.isArray(patch) ? patch : { ...valid(), ...patch };
    expect(() => validateWebsiteQaReport(report)).toThrow("Relatório QA");
  });
});
