"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ApiError } from "../../components/sites/api";
import type { WebsiteAsset, WebsiteDeployment, WebsiteFiles, WebsiteProject, WebsiteSettings } from "./types";

export type SiteIdentity = { authenticated: boolean; clientId: string | null; actorId?: string };
export type DeploymentAttempt = { key: string; deploymentId?: string };
export type StagedUpload = { id: string; file: File; url: string; problem?: string; uploadError?: string; uncertain?: boolean; purpose?: WebsiteAsset["purpose"]; purposeExplicit?: boolean };

type SiteDrafts = {
  files: { files: WebsiteFiles; revisionId: string | null };
  project: WebsiteProject;
  chat: { prompt: string; selected: string[]; stagedCount?: number };
  settings: { values: WebsiteSettings | null; prompt: string | null; allowlist: string | null };
  deployments: { publish: Map<string, DeploymentAttempt>; rollback: Map<string, DeploymentAttempt> };
};
const drafts = new Map<string, Partial<SiteDrafts>>();
let confirmedIdentity: string | null = null;

export function siteDraftScope(identity: SiteIdentity | null, projectId: string): string | null {
  return identity?.authenticated && identity.clientId && projectId
    ? JSON.stringify([identity.clientId, identity.actorId ?? identity.clientId, projectId]) : null;
}

export function clearSiteDrafts(): void {
  drafts.clear();
}

export function getSiteDraft<K extends keyof SiteDrafts>(scope: string | null, area: K): SiteDrafts[K] | null {
  return scope ? drafts.get(scope)?.[area] ?? null : null;
}

export function setSiteDraft<K extends keyof SiteDrafts>(scope: string | null, area: K, value: SiteDrafts[K] | null): void {
  if (!scope) return;
  const entry = drafts.get(scope) ?? {};
  if (value === null) delete entry[area];
  else entry[area] = value;
  if (Object.keys(entry).length) drafts.set(scope, entry);
  else drafts.delete(scope);
}

export function useSiteDraft<K extends keyof SiteDrafts>(scope: string, area: K): [SiteDrafts[K] | null, Dispatch<SetStateAction<SiteDrafts[K] | null>>] {
  const [value, setValue] = useState(() => getSiteDraft(scope, area));
  const latest = useRef(value);
  const update = useCallback((next: SetStateAction<SiteDrafts[K] | null>) => {
    const result = typeof next === "function" ? next(latest.current) : next;
    latest.current = result;
    setSiteDraft(scope, area, result);
    setValue(result);
  }, [scope, area]);
  return [value, update];
}

export function useSiteIdentity(): { identity: SiteIdentity | null; failed: boolean; retry: () => void } {
  const [identity, setIdentity] = useState<SiteIdentity | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let controller: AbortController;
    const load = () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      setFailed(false);
      void fetch("/api/auth/session", { cache: "no-store", signal }).then(async (response) => {
        const data: SiteIdentity = await response.json();
        if (signal.aborted) return;
        if (!response.ok || data.authenticated !== true || typeof data.clientId !== "string" || !data.clientId) throw new Error();
        const next = { authenticated: true, clientId: data.clientId, actorId: typeof data.actorId === "string" ? data.actorId : undefined };
        const key = siteDraftScope(next, "identity");
        if (confirmedIdentity !== key) clearSiteDrafts();
        confirmedIdentity = key;
        setIdentity(next);
      }).catch(() => { if (!signal.aborted) { clearSiteDrafts(); confirmedIdentity = null; setFailed(true); } });
    };
    const changed = () => { clearSiteDrafts(); load(); };
    load();
    window.addEventListener("session-changed", changed);
    return () => { controller.abort(); window.removeEventListener("session-changed", changed); };
  }, [attempt]);
  return { identity, failed, retry: useCallback(() => setAttempt((value) => value + 1), []) };
}

export function useDraftUnloadWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}

export function reconcileDeploymentKeys(keys: Map<string, DeploymentAttempt>, deployments: Pick<WebsiteDeployment, "id" | "status">[]): void {
  for (const [target, attempt] of keys) {
    if (attempt.deploymentId && deployments.some((item) => item.id === attempt.deploymentId && (item.status === "published" || item.status === "failed"))) keys.delete(target);
  }
}

export async function deploymentResponse(response: Response): Promise<WebsiteDeployment> {
  const data = await response.json().catch(() => null) as { deployment?: WebsiteDeployment } | null;
  const deployment = data?.deployment;
  if (deployment && typeof deployment.id === "string" && ["deploying", "published", "failed"].includes(deployment.status)
    && (response.ok || (response.status === 409 && deployment.status === "failed"))) return deployment;
  throw new ApiError("Não foi possível confirmar a publicação. Atualize o histórico antes de tentar novamente.", response.status);
}

export function stagedFileProblem(file: File): string | undefined {
  return !["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size === 0 || file.size > 8 * 1024 * 1024
    ? "PNG, JPEG ou WEBP até 8 MB" : undefined;
}

export async function uploadStagedFiles<T>(items: StagedUpload[], upload: (item: StagedUpload) => Promise<T>, success: (item: StagedUpload, result: T) => void, failure: (item: StagedUpload, error: unknown) => void, signal?: AbortSignal): Promise<void> {
  for (const item of items) {
    if (signal?.aborted) break;
    if (item.problem || item.uncertain) continue;
    let result: T;
    try { result = await upload(item); }
    catch (error) { failure(item, error); break; }
    success(item, result);
  }
}
