import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WebsiteFiles, WebsiteRun } from "./types";
import { normalizeWebsitePath, validateFiles } from "./validation";
import { parseWebsiteDesignDirection, type WebsiteDesignDirection } from "./impeccable";
import { databaseError } from "./repository";
import { validateWebsiteQaReport, type WebsiteQaReport } from "./qa-report";

export const CHECKPOINT_PREFIX = "[site-checkpoint:";
export const CHECKPOINT_RECOVERY_WARNING = "Checkpoint mais recente inválido ou incompleto; snapshot anterior recuperado. Revise o progresso antes de continuar.";
const MAX_RECOVERY_MARKERS = 5;
export interface WebsiteBudgetConsumed {
  requests: number;
  tools: number;
  outputTokens: number;
  totalTokens: number;
  qaRequests?: number;
  qaOutputTokens?: number;
}
export interface WebsiteRunProgress {
  stage: "editing" | "validating" | "blocked";
  changedPaths: string[];
  diagnostics: string[];
  nextAction: string;
}
export interface WebsiteRunCheckpoint {
  qaReport?: WebsiteQaReport;
  progress?: WebsiteRunProgress;
  budgetConsumed?: WebsiteBudgetConsumed;
  files: WebsiteFiles;
  request: string;
  notes?: string;
  assetIds: string[];
  designDirection?: WebsiteDesignDirection;
}

function validateCheckpointBudget(budget: WebsiteBudgetConsumed | undefined): void {
  if (budget === undefined) return;
  if (!budget || typeof budget !== "object" || Array.isArray(budget)
    || Object.keys(budget).some((key) => !["requests", "tools", "outputTokens", "totalTokens", "qaRequests", "qaOutputTokens"].includes(key))
    || [budget.requests, budget.tools, budget.outputTokens, budget.totalTokens, budget.qaRequests === undefined ? 0 : budget.qaRequests, budget.qaOutputTokens === undefined ? 0 : budget.qaOutputTokens].some((value) => !Number.isSafeInteger(value) || value < 0)
    || budget.totalTokens < budget.outputTokens + (budget.qaOutputTokens ?? 0)) throw new Error("Orçamento do checkpoint inválido.");
}

function validateCheckpointProgress(progress: WebsiteRunProgress | undefined): void {
  if (progress === undefined) return;
  if (!progress || typeof progress !== "object" || Array.isArray(progress)
    || Object.keys(progress).some((key) => !["stage", "changedPaths", "diagnostics", "nextAction"].includes(key))
    || !["editing", "validating", "blocked"].includes(progress.stage)
    || !Array.isArray(progress.changedPaths) || progress.changedPaths.length > 100 || progress.changedPaths.some((path) => typeof path !== "string")
    || !Array.isArray(progress.diagnostics) || progress.diagnostics.length > 8 || progress.diagnostics.some((error) => typeof error !== "string" || error.length > 2000)
    || typeof progress.nextAction !== "string" || progress.nextAction.length > 1000) throw new Error("Progresso do checkpoint inválido.");
  for (const path of progress.changedPaths) normalizeWebsitePath(path);
}

// Commit marker is written last: interrupted writes never replace a complete snapshot.
export async function saveRunCheckpoint(db: SupabaseClient, run: WebsiteRun, checkpoint: WebsiteRunCheckpoint, beforeCommit?: () => Promise<void>): Promise<void> {
  validateFiles(checkpoint.files);
  validateCheckpointBudget(checkpoint.budgetConsumed);
  validateCheckpointProgress(checkpoint.progress);
  validateWebsiteQaReport(checkpoint.qaReport);
  const id = randomUUID();
  const payload = JSON.stringify(checkpoint);
  const chunks: string[] = [];
  for (let offset = 0; offset < payload.length;) {
    let end = Math.min(offset + 30000, payload.length);
    if (end < payload.length && /[\uD800-\uDBFF]/.test(payload[end - 1])) end--;
    chunks.push(payload.slice(offset, end));
    offset = end;
  }
  const row = { client_id: run.client_id, project_id: run.project_id, run_id: run.id, role: "system" };
  const { error } = await db.from("website_messages").insert(chunks.map((chunk, index) => ({
    ...row, content: CHECKPOINT_PREFIX + id + ":" + index + "]" + chunk,
  })));
  databaseError(error);
  await beforeCommit?.();
  const committed = await db.from("website_messages").insert({
    ...row, content: CHECKPOINT_PREFIX + "commit:" + run.base_revision_id + "]" + JSON.stringify({ id, count: chunks.length }),
  });
  databaseError(committed.error);
}

function parseCheckpointCommit(content: string, prefix: string): { id: string; count: number } {
  const value = JSON.parse(content.slice(prefix.length)) as { id: string; count: number } | null;
  if (!value || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id) || !Number.isSafeInteger(value.count) || value.count < 1 || value.count > 1000) throw new Error("Checkpoint inválido.");
  return value;
}

function parseCheckpointChunks(rows: { content: string }[], id: string, count: number): WebsiteRunCheckpoint {
  const prefix = CHECKPOINT_PREFIX + id + ":";
  const chunks = new Map<number, string>();
  for (const row of rows) {
    const end = row.content.indexOf("]", prefix.length);
    const rawIndex = row.content.slice(prefix.length, end);
    const index = Number(rawIndex);
    if (!/^(?:0|[1-9]\d*)$/.test(rawIndex) || index >= count || chunks.has(index)) throw new Error("Checkpoint inválido.");
    chunks.set(index, row.content.slice(end + 1));
  }
  if (chunks.size !== count || Array.from({ length: count }, (_, index) => !chunks.has(index)).some(Boolean)) throw new Error("Checkpoint incompleto.");
  const value: unknown = JSON.parse(Array.from({ length: count }, (_, index) => chunks.get(index)).join(""));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Checkpoint inválido.");
  const checkpoint = value as WebsiteRunCheckpoint;
  if (checkpoint.notes !== undefined && typeof checkpoint.notes !== "string") throw new Error("Checkpoint inválido.");
  validateFiles(checkpoint.files);
  validateCheckpointBudget(checkpoint.budgetConsumed);
  validateCheckpointProgress(checkpoint.progress);
  validateWebsiteQaReport(checkpoint.qaReport);
  if (typeof checkpoint.request !== "string" || !Array.isArray(checkpoint.assetIds) || checkpoint.assetIds.some(id => typeof id !== "string")) throw new Error("Checkpoint inválido.");
  return { ...checkpoint, ...(checkpoint.designDirection !== undefined ? { designDirection: parseWebsiteDesignDirection(checkpoint.designDirection) } : {}) };
}

export async function loadRunCheckpoint(db: SupabaseClient, run: WebsiteRun, exactRun = false): Promise<WebsiteRunCheckpoint | undefined> {
  if (run.kind === "build") return undefined;
  const prefix = CHECKPOINT_PREFIX + "commit:" + run.base_revision_id + "]";
  const queryMarkers = (currentRunOnly: boolean) => {
    let query = db.from("website_messages").select("content,run_id")
      .eq("client_id", run.client_id).eq("project_id", run.project_id).eq("role", "system");
    if (currentRunOnly) query = query.eq("run_id", run.id);
    return query.like("content", prefix + "%").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(currentRunOnly ? 1 : MAX_RECOVERY_MARKERS);
  };
  // A retry must prefer its own admission ledger even if another run wrote more recently.
  let markers = await queryMarkers(true);
  databaseError(markers.error);
  if (!markers.data?.length && !exactRun) {
    markers = await queryMarkers(false);
    databaseError(markers.error);
  }
  if (!markers.data?.length) return undefined;
  let corruption: unknown;
  for (const marker of markers.data) {
    let commit: { id: string; count: number };
    try { commit = parseCheckpointCommit(marker.content, prefix); }
    catch (error) { if (marker.run_id === run.id) throw error; corruption = error; continue; }
    const result = await db.from("website_messages").select("content")
      .eq("client_id", run.client_id).eq("project_id", run.project_id).eq("role", "system").eq("run_id", marker.run_id)
      .like("content", CHECKPOINT_PREFIX + commit.id + ":%").limit(commit.count + 1);
    databaseError(result.error);
    let checkpoint: WebsiteRunCheckpoint;
    try { checkpoint = parseCheckpointChunks(result.data ?? [], commit.id, commit.count); }
    catch (error) {
      // ponytail: current-run corruption blocks retries; older accounting must never admit new spend.
      if (marker.run_id === run.id) throw error;
      corruption = error;
      continue;
    }
    if (marker.run_id !== run.id) {
      const { budgetConsumed: _previousBudget, ...recovered } = checkpoint;
      checkpoint = recovered;
    }
    if (!corruption) return checkpoint;
    return { ...checkpoint, progress: {
      stage: "blocked", changedPaths: checkpoint.progress?.changedPaths ?? [],
      diagnostics: [CHECKPOINT_RECOVERY_WARNING, ...(checkpoint.progress?.diagnostics ?? [])].slice(0, 8),
      nextAction: CHECKPOINT_RECOVERY_WARNING,
    } };
  }
  throw corruption ?? new Error("Checkpoint inválido.");
}
