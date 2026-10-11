// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityLogger, activityLogger } from "../activity-logger";
import { AgentActivityTracker } from "../agent-activity-tracker";
import type { WebsiteRun } from "../types";
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-11T12:00:00Z")); activityLogger.clear(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 }))); });
afterEach(() => { activityLogger.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const last = (logger: ActivityLogger) => logger.getEvents().at(-1)!;
const persisted = () => vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)).events as Array<{ type: string; status: string }>);
describe("activity logging behavior", () => {
  it("delivers events, unsubscribes idempotently and protects the returned list", () => {
    const logger = new ActivityLogger(), callback = vi.fn(), unsubscribe = logger.onActivity(callback);
    logger.info("Preparando");
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ type: "info", message: "Preparando" }));
    logger.getEvents().pop(); expect(logger.getEvents()).toHaveLength(1);
    unsubscribe(); unsubscribe(); logger.error("Falhou"); expect(callback).toHaveBeenCalledOnce();
    logger.clear(); expect(logger.getEvents()).toEqual([]);
  });
  it.each(["read", "read_files", "write", "create", "patch", "delete", "search", "list", "get_context", "assets", "checkpoint", "restore", "run_validation", "read_design_reference", "record_design_direction", "other"])("records %s correlation, duration and fallback", tool => {
    const logger = new ActivityLogger();
    for (const params of [undefined, { path: "src/App.tsx", paths: ["a", "b"], query: "title", name: "layout" }]) {
      const id = logger.toolStart(tool, params);
      expect(last(logger)).toMatchObject({ type: "tool_start", status: "pending", details: { toolName: tool } });
      vi.advanceTimersByTime(50);
      logger.toolComplete(id, { path: "src/App.tsx", saved: "src/App.tsx", length: 2, passed: true, name: "layout" });
      expect(last(logger)).toMatchObject({ type: "tool_complete", status: "success", duration: 50, details: { originalId: id } });
      logger.toolComplete(logger.toolStart(tool));
      expect(last(logger).message).not.toContain("undefined");
    }
    logger.toolComplete(logger.toolStart("run_validation"), { passed: false, errors: ["syntax"] });
    expect(last(logger).message).toContain("1 erro");
  });
  it("records tool failure and model retry timing without losing cumulative usage", () => {
    const logger = new ActivityLogger(), tool = logger.toolStart("patch");
    vi.advanceTimersByTime(10); logger.toolError(tool, "ambíguo"); expect(last(logger)).toMatchObject({ status: "error", duration: 10 });
    logger.toolError("missing", "missing"); logger.toolComplete("missing"); expect(last(logger).duration).toBeUndefined();
    const model = logger.modelStart("model", "editar");
    logger.modelThinking(model, "inspecionando"); logger.modelRetrying(model, 2, 3, 4);
    expect(last(logger).message).toContain("4s");
    vi.advanceTimersByTime(100); logger.modelError(model, "temporário", 1, 3);
    vi.advanceTimersByTime(100); logger.modelComplete(model, { inputTokens: 10, outputTokens: 5 });
    expect(last(logger).duration).toBe(200);
    logger.modelComplete(logger.modelStart("other"), { inputTokens: 2 });
    logger.modelComplete("missing", { outputTokens: 3 }); logger.modelComplete("missing");
    expect(logger.getTotalUsage()).toEqual({ inputTokens: 12, outputTokens: 8 });
    const failed = logger.modelStart("bad"); logger.modelError(failed, "fatal", 3, 3); logger.modelComplete(failed);
    expect(last(logger).duration).toBeUndefined(); logger.modelError("missing", "fatal");
  });
  it("records validation, build and informational milestones with explicit status", () => {
    const logger = new ActivityLogger();
    for (const type of ["static", "build"] as const) for (const passed of [true, false]) {
      const id = logger.validationStart(type); vi.advanceTimersByTime(1);
      logger.validationComplete(id, { passed, errors: passed ? [] : ["syntax"], warnings: [] });
      expect(last(logger)).toMatchObject({ status: passed ? "success" : "error", duration: 1 });
    }
    logger.validationComplete("missing", { passed: false, errors: [], warnings: [] });
    const build = logger.buildStart(); logger.buildProgress(build, "compilando"); vi.advanceTimersByTime(1); logger.buildComplete(build, true);
    expect(last(logger)).toMatchObject({ duration: 1, details: { screenshots: true } });
    logger.buildComplete("missing"); logger.buildError(logger.buildStart(), "compile"); logger.buildError("missing", "compile");
    logger.checkpointCreated("before"); logger.revisionCreated("123456789"); logger.thinking("inspect"); logger.planning("patch"); logger.info("ready"); logger.error("failed");
    expect(logger.getEvents().slice(-6).map(event => event.type)).toEqual(["checkpoint_created", "revision_created", "thinking", "planning", "info", "error"]);
  });
});
describe("activity tracker offline persistence", () => {
  const tracker = () => new AgentActivityTracker({ id: "offline-run" } as WebsiteRun);
  it("preserves successful operation results and persists lifecycle with run scope", async () => {
    const subject = tracker();
    expect(await subject.trackTool("read", {}, async () => "source")).toBe("source");
    expect(persisted()[0].map(event => event.type)).toEqual(["tool_start", "tool_complete"]);
    expect(fetch).toHaveBeenCalledWith("/api/sites/runs/offline-run/activities", expect.objectContaining({ method: "POST" }));
    await subject.trackModelCall("model", "edit", async () => "response", () => ({ inputTokens: 2, outputTokens: 1 }));
    await subject.trackModelCall("model", "edit", async () => "response");
    expect(subject.getUsageSummary()).toEqual({ inputTokens: 2, outputTokens: 1 });
    await subject.trackValidation("static", async () => ({ passed: true, errors: [], warnings: [] }), result => result);
    await subject.trackValidation("build", async () => "unchecked");
    expect(await subject.trackBuild(async progress => { progress("preparing"); progress("concluído"); progress("erro"); return "artifact"; })).toBe("artifact");
    subject.trackModelThinking("id", "inspect"); subject.thinking("inspect"); subject.checkpoint("before"); subject.revision("revision"); subject.planning("patch"); subject.info("ready"); subject.error("failed");
    expect(last(activityLogger).status).toBe("error"); subject.clear(); expect(activityLogger.getEvents()).toEqual([]);
  });
  it.each([new Error("offline"), "offline"])("preserves operation failure identity %s", async reason => {
    const subject = tracker();
    const fail = async () => { throw reason; };
    await expect(subject.trackTool("patch", undefined, fail)).rejects.toBe(reason);
    await expect(subject.trackModelCall("model", "edit", fail)).rejects.toBe(reason);
    await expect(subject.trackValidation("static", fail)).rejects.toBe(reason);
    await expect(subject.trackBuild(fail)).rejects.toBe(reason);
    expect(persisted().every(events => events.at(-1)?.status === "error")).toBe(true);
  });
  it("reports transport failures without replacing operation result", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await tracker().trackTool("list", {}, async () => ["src/App.tsx"])).toEqual(["src/App.tsx"]);
    expect(log).toHaveBeenCalledWith("Failed to persist activity:", expect.any(Error));
  });
});
