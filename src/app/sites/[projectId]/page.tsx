"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, CheckCircle2, ExternalLink, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiJson, ApiError, errorMessage, friendlyRunError, isActiveRun, jsonBody } from "@/components/sites/api";
import { SiteChat } from "@/components/sites/site-chat";
import { SiteFilesPanel } from "@/components/sites/site-files-panel";
import { SiteProjectPanel } from "@/components/sites/site-project-panel";
import { RealtimeFilesViewer } from "@/components/sites/realtime-files-viewer";
import { completionNotice, isPublishableBuild, projectStatusLabel, safeSiteUrl } from "@/lib/sites/ui-helpers";
import { deploymentResponse, getSiteDraft, reconcileDeploymentKeys, setSiteDraft, siteDraftScope, useDraftUnloadWarning, useSiteIdentity, type DeploymentAttempt } from "@/lib/sites/ui";
import type { WebsiteBuild, WebsiteDeployment, WebsiteFiles, WebsiteProject, WebsiteRun } from "@/lib/sites/types";

const SitePreview = dynamic(() => import("@/components/sites/site-preview").then((module) => module.SitePreview), { ssr: false, loading: () => <p role="status" className="p-6 text-sm text-muted-foreground">Carregando pré-visualização...</p> });

export default function SiteProjectPage(): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const { identity, failed, retry } = useSiteIdentity();
  const scope = siteDraftScope(identity, projectId);
  if (failed) return <div role="alert" className="space-y-2 p-6"><p>Não foi possível confirmar o acesso. Tente novamente.</p><Button variant="outline" onClick={retry}>Tentar novamente</Button></div>;
  if (!scope || !identity?.clientId) return <p role="status" className="p-6">Confirmando acesso ao projeto...</p>;
  return <Editor key={scope} projectId={projectId} clientId={identity.clientId} draftScope={scope} />;
}

function Editor({ projectId, clientId, draftScope }: { projectId: string; clientId: string; draftScope: string }): React.JSX.Element {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<{ project: WebsiteProject; files: WebsiteFiles } | null>(null);
  const [previousFiles, setPreviousFiles] = useState<WebsiteFiles | null>(null);
  const [checkpointPreview, setCheckpointPreview] = useState<{ version: string; run_id: string; base_revision_id: string | null; files: WebsiteFiles } | null>(null);
  const checkpointEtag = useRef<{ runId: string; value: string } | null>(null);
  const snapshotRevision = useRef<string | null>(null);
  const [runs, setRuns] = useState<WebsiteRun[]>([]);
  const [runsReady, setRunsReady] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("chat");
  const [previewSubtab, setPreviewSubtab] = useState<"preview" | "files" | "realtime">("preview");
  const [working, setWorking] = useState(false);
  const [operation, setOperation] = useState("");
  const [operationError, setOperationError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [filesDirty, setFilesDirty] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [deploymentPending, setDeploymentPending] = useState(false);
  const [deploymentsReady, setDeploymentsReady] = useState(false);
  const hasDraft = filesDirty || settingsDirty;
  const reloadSequence = useRef(0);
  const previousRuns = useRef(new Map<string, WebsiteRun>());
  const runsSequence = useRef(0);
  const lifecycle = useRef<AbortController | null>(null);
  const actionLock = useRef(false);
  const [attempts] = useState(() => getSiteDraft(draftScope, "deployments") ?? { publish: new Map<string, DeploymentAttempt>(), rollback: new Map<string, DeploymentAttempt>() });
  const deployKeys = useRef(attempts.publish);
  const rollbackKeys = useRef(attempts.rollback);
  const previousDeployments = useRef(new Map<string, WebsiteDeployment>());
  const base = `/api/sites/${projectId}`;

  const reload = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const sequence = ++reloadSequence.current;
    for (let attempt = 0; attempt < 2; attempt++) {
      const first = await apiJson<{ project: WebsiteProject }>(base, { signal });
      const files = await apiJson<{ files: WebsiteFiles }>(`${base}/files`, { signal });
      const latest = await apiJson<{ project: WebsiteProject }>(base, { signal });
      if (first.project.client_id !== clientId || latest.project.client_id !== clientId || latest.project.id !== projectId) throw new ApiError("Acesso não permitido.", 403);
      if (first.project.current_revision_id !== latest.project.current_revision_id) continue;
      if (!signal?.aborted && sequence === reloadSequence.current) {
        // Salva estado anterior para comparação
        if (snapshot?.files) setPreviousFiles(snapshot.files);
        snapshotRevision.current = latest.project.current_revision_id;
        setSnapshot({ project: latest.project, files: files.files });
        setCheckpointPreview(null);
        checkpointEtag.current = null;
        setError("");
        setRefresh((value) => value + 1);
      }
      return;
    }
    throw new ApiError("O projeto está sendo alterado. Aguarde e recarregue.", 409);
  }, [base, clientId, projectId, snapshot]);

  const receiveRuns = useCallback((next: WebsiteRun[]) => {
    let completedAgentRun = false;
    for (const run of next) {
      const previous = previousRuns.current.get(run.id);
      if (!previous || !isActiveRun(previous.status) || isActiveRun(run.status)) continue;
      if (run.status === "completed") {
        if (run.kind === "agent") completedAgentRun = true;
        void reload(lifecycle.current?.signal)
          .then(async () => {
            if (run.kind === "agent") {
              setTab("preview");
              setPreviewSubtab("preview");
            }
            try {
              const { builds: latestBuilds } = await apiJson<{ builds: Omit<WebsiteBuild, "artifact">[] }>(`${base}/builds`, { signal: lifecycle.current?.signal });
              const notice = completionNotice(run.kind, latestBuilds?.[0]);
              if (notice.type === "warning") toast.warning(notice.message);
              else if (notice.type === "info") toast.info(notice.message);
              else toast.success(notice.message);
            } catch {
              toast.info("Execução encerrada. Não foi possível confirmar o relatório de validação; consulte os Ajustes.");
            }
          })
          .catch((err: unknown) => { if (!lifecycle.current?.signal.aborted) { setError(errorMessage(err)); toast.error(errorMessage(err)); } });
      } else if (run.status === "failed") toast.error(friendlyRunError(run.error));
      else toast.info("Execução cancelada.");
    }
    previousRuns.current = new Map(next.map((run) => [run.id, run]));
    setRuns(next); setRunsReady(true);
    if (completedAgentRun) {
      setTab("preview");
      setPreviewSubtab("preview");
    }
  }, [reload, base]);

  const loadRuns = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const sequence = ++runsSequence.current;
    const stale = () => signal?.aborted || sequence !== runsSequence.current;
    const data = await apiJson<{ runs: WebsiteRun[] }>(`${base}/runs`, { signal });
    if (stale()) return;
    try {
      const candidate = data.runs.find((run) => run.kind !== "build");
      if (!candidate || candidate.status === "completed" || getSiteDraft(draftScope, "files") || getSiteDraft(draftScope, "project")) return;
      const known = checkpointEtag.current?.runId === candidate.id ? checkpointEtag.current.value : undefined;
      const response = await fetch(`${base}/files?run_id=${encodeURIComponent(candidate.id)}`, { signal, cache: "no-store", ...(known ? { headers: { "If-None-Match": known } } : {}) });
      if (stale() || response.status === 304) return;
      if (!response.ok) throw new ApiError("Não foi possível carregar o rascunho confirmado.", response.status);
      const { checkpoint } = await response.json() as { checkpoint: { version: string; run_id: string; base_revision_id: string | null; files: WebsiteFiles } | null };
      if (stale() || getSiteDraft(draftScope, "files") || getSiteDraft(draftScope, "project")) return;
      if (checkpoint && (checkpoint.run_id !== candidate.id || checkpoint.base_revision_id !== snapshotRevision.current)) return;
      checkpointEtag.current = { runId: candidate.id, value: response.headers.get("ETag") ?? "" };
      setCheckpointPreview(checkpoint);
    } finally {
      // Apply terminal status after loading its checkpoint so polling cleanup cannot abort it.
      if (!stale()) receiveRuns(data.runs);
    }
  }, [base, receiveRuns, draftScope]);

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    void reload(controller.signal).then(() => loadRuns(controller.signal)).catch((err: unknown) => {
      if (controller.signal.aborted) return;
      const message = errorMessage(err); setError(message); toast.error(message);
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) router.replace("/sites");
    });
    return () => controller.abort();
  }, [reload, loadRuns, router]);

  const loadDeployments = useCallback(async (signal: AbortSignal): Promise<boolean> => {
    const { deployments } = await apiJson<{ deployments: WebsiteDeployment[] }>(`${base}/deployments`, { signal });
    if (signal.aborted) return false;
    reconcileDeploymentKeys(deployKeys.current, deployments);
    reconcileDeploymentKeys(rollbackKeys.current, deployments);
    const settled = deployments.some((item) => previousDeployments.current.get(item.id)?.status === "deploying" && item.status !== "deploying");
    for (const item of deployments) {
      if (previousDeployments.current.get(item.id)?.status === "deploying" && item.status === "failed")
        toast.error(`A publicação não foi concluída: ${item.error ?? "consulte o histórico de publicações."}`, { id: `sites-deployment-${item.id}` });
    }
    previousDeployments.current = new Map(deployments.map((item) => [item.id, item]));
    const pending = deployments.some((item) => item.status === "deploying");
    setDeploymentPending(pending); setDeploymentsReady(true);
    if (settled) await reload(lifecycle.current?.signal);
    return pending;
  }, [base, reload]);

  useEffect(() => {
    if (working) return;
    const controller = new AbortController();
    const deadline = Date.now() + 5 * 60_000;
    let timer: ReturnType<typeof setTimeout>;
    async function poll(): Promise<void> {
      let pending = true;
      try { pending = await loadDeployments(controller.signal); }
      catch (err) { if (!controller.signal.aborted) toast.error(errorMessage(err), { id: "sites-deployments" }); }
      if (pending && !controller.signal.aborted && Date.now() < deadline) timer = setTimeout(() => void poll(), 3000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [loadDeployments, working, refresh]);

  const activeRun = runs.find((run) => isActiveRun(run.status)) ?? null;
  const hasActive = Boolean(activeRun);

  // ✅ NOVO: SSE listener para eventos de arquivo em tempo real
  useEffect(() => {
    if (!activeRun || working) return;

    const eventSource = new EventSource(`${base}/runs/${activeRun.id}/activities?stream=true`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Detectar mudança de arquivo
        if (
          data.type?.startsWith("file_") &&
          data.status === "completed" &&
          data.details?.path
        ) {
          console.log(`[SSE] File ${data.type} detected:`, data.details.path);

          // Buscar checkpoint atualizado
          void (async () => {
            try {
              const response = await fetch(`${base}/files?run_id=${encodeURIComponent(activeRun.id)}`, { cache: "no-store" });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);

              const responseData = await response.json() as { checkpoint: { version: string; run_id: string; base_revision_id: string | null; files: WebsiteFiles } | null };

              if (responseData.checkpoint) {
                console.log(`[Checkpoint] Updated with ${Object.keys(responseData.checkpoint.files).length} files`);
                checkpointEtag.current = { runId: activeRun.id, value: response.headers.get("ETag") ?? "" };
                setCheckpointPreview(responseData.checkpoint);
              }
            } catch (err) {
              console.error("[Checkpoint] Fetch error:", err);
            }
          })();
        }
      } catch (e) {
        console.error("[SSE] Parse error:", e);
      }
    };

    eventSource.onerror = () => {
      console.warn("[SSE] Connection lost, will retry...");
      eventSource.close();
    };

    return () => {
      console.log("[SSE] Cleaning up connection");
      eventSource.close();
    };
  }, [activeRun, working, base]);

  useEffect(() => {
    if (!hasActive || working) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll(): Promise<void> {
      try { await loadRuns(controller.signal); }
      catch (err) { if (!controller.signal.aborted) toast.error(errorMessage(err), { id: "sites-runs" }); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1200);
    }
    timer = setTimeout(() => void poll(), 800);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [hasActive, working, loadRuns]);

  useDraftUnloadWarning(hasDraft);

  function queued(run: WebsiteRun): void {
    runsSequence.current++;
    checkpointEtag.current = null;
    previousRuns.current.set(run.id, run);
    setRuns((prev) => [run, ...prev.filter((item) => item.id !== run.id)]);
  }

  async function wait(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const cancel = () => { clearTimeout(timer); reject(new DOMException("Cancelado", "AbortError")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, 3000);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  async function deploymentResult(deployment: WebsiteDeployment, signal: AbortSignal): Promise<void> {
    let current = deployment;
    const deadline = Date.now() + 5 * 60_000;
    while (current.status === "deploying") {
      if (Date.now() > deadline) throw new ApiError("A publicação continua pendente. Consulte o histórico antes de tentar novamente.", 408);
      await wait(signal);
      const data = await apiJson<{ deployments: WebsiteDeployment[] }>(`${base}/deployments`, { signal });
      current = data.deployments.find((item) => item.id === deployment.id) ?? current;
    }
    reconcileDeploymentKeys(deployKeys.current, [current]);
    reconcileDeploymentKeys(rollbackKeys.current, [current]);
    previousDeployments.current.set(current.id, current);
    if (current.status !== "published") throw new ApiError(current.error ? `A publicação não foi concluída: ${current.error}` : "A publicação não foi concluída. Consulte o histórico e tente novamente.", 409);
    await reload(signal);
    toast.success("Site publicado com sucesso.");
  }

  function beginMutation(): boolean {
    if (!snapshot || actionLock.current || activeRun || !runsReady || !deploymentsReady || deploymentPending || snapshot.project.status === "archived") return false;
    actionLock.current = true; setWorking(true);
    return true;
  }

  function endMutation(): void {
    actionLock.current = false;
    if (!lifecycle.current?.signal.aborted) { setWorking(false); setDeploymentsReady(false); setOperation(""); setRefresh((value) => value + 1); }
  }

  async function publishOrValidate(publish: boolean): Promise<void> {
    if (!snapshot || hasDraft || !beginMutation()) return;
    setOperationError(""); setOperation("Verificando validações existentes...");
    const signal = lifecycle.current!.signal;
    try {
      const revisionId = snapshot.project.current_revision_id;
      let buildId: string | null = null;
      if (publish) {
        const existing = await apiJson<{ builds: Omit<WebsiteBuild, "artifact">[] }>(`${base}/builds`, { signal });
        const reusable = existing.builds.find((item) => item.revision_id === revisionId && isPublishableBuild(item));
        if (reusable) { buildId = reusable.id; toast.info("Publicando com a validação aprovada desta revisão, sem refazer a validação."); }
      }
      if (!buildId) {
        setOperation("Validando o site...");
        const { run } = await apiJson<{ run: WebsiteRun }>(`${base}/builds`, { ...jsonBody({ expected_revision_id: revisionId }), signal });
        queued(run);
        if (!publish) { toast.info("Validação enviada para a fila."); return; }
        let current = run;
        const deadline = Date.now() + 16 * 60_000;
        while (isActiveRun(current.status)) {
          if (Date.now() > deadline) throw new ApiError("A validação ainda está pendente. Consulte a execução antes de publicar novamente.", 408);
          await wait(signal);
          const data = await apiJson<{ runs: WebsiteRun[] }>(`${base}/runs`, { signal });
          receiveRuns(data.runs);
          current = data.runs.find((item) => item.id === run.id) ?? current;
        }
        if (current.status !== "completed") throw new ApiError(current.status === "cancelled" ? "Publicação interrompida: validação cancelada." : friendlyRunError(current.error), 409);
        signal.throwIfAborted();
        const fresh = await apiJson<{ builds: Omit<WebsiteBuild, "artifact">[] }>(`${base}/builds`, { signal });
        const build = fresh.builds.find((item) => item.revision_id === revisionId && Date.parse(item.created_at) >= Date.parse(run.created_at));
        if (!build || !isPublishableBuild(build)) throw new ApiError("A validação desta revisão não está pronta para publicação: exige QA aprovado, crítica visual e screenshots reais. Consulte a lista de Validações nos Ajustes.", 409);
        buildId = build.id;
      }
      setOperation("Publicando o site...");
      let attempt = deployKeys.current.get(buildId);
      if (!attempt) { attempt = { key: crypto.randomUUID().replaceAll("-", "") }; deployKeys.current.set(buildId, attempt); }
      setSiteDraft(draftScope, "deployments", attempts);
      const deployment = await fetch(`${base}/deployments`, { ...jsonBody({ build_id: buildId }), headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.key }, signal }).then(deploymentResponse);
      attempt.deploymentId = deployment.id;
      await deploymentResult(deployment, signal);
    } catch (err) {
      if (!signal.aborted) { const message = errorMessage(err); setOperationError(message); toast.error(message); }
    } finally { endMutation(); }
  }

  async function rollback(deploymentId: string): Promise<void> {
    if (actionLock.current || activeRun || deploymentPending || !window.confirm("Voltar o site público para esta publicação? O código em edição não será alterado.") || !beginMutation()) return;
    setOperationError(""); setOperation("Restaurando publicação...");
    const signal = lifecycle.current!.signal;
    try {
      let attempt = rollbackKeys.current.get(deploymentId);
      if (!attempt) { attempt = { key: crypto.randomUUID().replaceAll("-", "") }; rollbackKeys.current.set(deploymentId, attempt); }
      setSiteDraft(draftScope, "deployments", attempts);
      const deployment = await fetch(`${base}/deployments/${deploymentId}/rollback`, { method: "POST", headers: { "Idempotency-Key": attempt.key }, signal }).then(deploymentResponse);
      attempt.deploymentId = deployment.id;
      await deploymentResult(deployment, signal);
    } catch (err) {
      if (!signal.aborted) { setOperationError(errorMessage(err)); toast.error(errorMessage(err)); }
    } finally { endMutation(); }
  }

  if (!snapshot) return <div className="space-y-4 p-6" role={error ? "alert" : "status"}>{error || "Carregando projeto..."}{error && <Link href="/sites" className="block text-primary underline">Voltar para Meus Sites</Link>}</div>;
  const project = snapshot.project;
  const url = safeSiteUrl(project.published_url);
  const disabled = working || hasActive || !runsReady || !deploymentsReady || deploymentPending || project.status === "archived";
  const actionDisabled = disabled || hasDraft;
  const sections = [["chat", "Chat"], ["preview", "Preview"], ["settings", "Ajustes"]] as const;

  return <div className="flex h-full min-h-0 flex-col">
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-3 py-3">
      <Link href="/sites" aria-label="Voltar para Meus Sites" className="rounded p-2 hover:bg-secondary"><ArrowLeft className="size-4" /></Link>
      <h1 className="min-w-0 max-w-full truncate text-lg font-semibold">{project.name}</h1><Badge variant={project.status === "published" ? "default" : "secondary"}>{projectStatusLabel(project.status)}</Badge>
      <div className="ml-auto flex flex-wrap gap-2"><Button variant="outline" disabled={actionDisabled} onClick={() => void publishOrValidate(false)}><CheckCircle2 aria-hidden="true" />Validar</Button><Button disabled={actionDisabled} onClick={() => void publishOrValidate(true)}><Rocket aria-hidden="true" />Publicar</Button>{url && <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-border px-3 text-sm"><ExternalLink className="size-4" aria-hidden="true" />Ver site</a>}</div>
    </header>
    {hasDraft && <p role="status" className="border-b border-border px-4 py-2 text-xs text-muted-foreground">Salve ou descarte as alterações em Arquivos e Ajustes antes de executar o agente ou publicar. Rascunhos ficam nesta aba durante a navegação, mas são perdidos ao recarregar ou trocar de conta.</p>}
    {error && <div role="alert" className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm"><p>{error}</p><Button variant="outline" onClick={() => void reload(lifecycle.current?.signal).then(() => loadRuns(lifecycle.current?.signal)).catch((err: unknown) => toast.error(errorMessage(err)))}>Recarregar projeto</Button></div>}
    {!working && (deploymentPending || !deploymentsReady) && <div role="status" className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs"><p>{deploymentPending ? "Há uma publicação pendente. Novas alterações estão bloqueadas até a confirmação do servidor." : "Verificando publicações pendentes..."}</p><Button size="sm" variant="outline" onClick={() => setRefresh((value) => value + 1)}>Atualizar estado</Button></div>}
    {operation && <p role="status" className="border-b border-border px-4 py-2 text-sm text-primary">{operation} Mantenha esta página aberta.</p>}
    {operationError && <p role="alert" className="border-b border-destructive/30 px-4 py-2 text-sm">{operationError} <Link href="/sites/settings" className="text-primary underline">Configurações</Link></p>}
    <div role="tablist" aria-label="Áreas do editor" className="flex shrink-0 border-b border-border lg:hidden">{sections.map(([key, label], index) => <button key={key} role="tab" id={`editor-tab-${key}`} aria-controls={`editor-${key}`} aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} className={`min-h-11 flex-1 text-sm ${tab === key ? "border-b-2 border-primary text-primary" : "text-muted-foreground"}`} onClick={() => setTab(key)} onKeyDown={(event) => {
      const target = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : -1;
      if (target >= 0) { event.preventDefault(); setTab(sections[target][0]); document.getElementById(`editor-tab-${sections[target][0]}`)?.focus(); }
    }}>{label}</button>)}</div>
    <div className="min-h-0 flex-1 overflow-auto lg:grid lg:grid-cols-[minmax(260px,360px)_minmax(0,1fr)_minmax(280px,380px)] lg:overflow-hidden">
      <section id="editor-chat" role="tabpanel" tabIndex={0} aria-label="Chat" className={`${tab === "chat" ? "block" : "hidden"} h-full min-h-0 border-r border-border lg:block lg:overflow-auto`}><SiteChat draftScope={draftScope} projectId={projectId} project={project} activeRun={activeRun} runs={runs} blocked={actionDisabled} onQueued={queued} onRunsChanged={loadRuns} onProjectChanged={reload} onMutationStart={beginMutation} onMutationEnd={endMutation} /></section>
      <section id="editor-preview" role="tabpanel" tabIndex={0} aria-label="Preview e arquivos" className={`${tab === "preview" ? "flex" : "hidden"} flex-col h-full min-h-0 min-w-0 overflow-hidden lg:flex`}>
        <Tabs value={previewSubtab} onValueChange={(val) => setPreviewSubtab(val as "preview" | "files" | "realtime")} className="flex flex-1 flex-col h-full min-h-0 min-w-0 gap-0 overflow-hidden">
          <TabsList className="m-3 self-start shrink-0">
            <TabsTrigger value="preview">Preview</TabsTrigger>
            <TabsTrigger value="realtime">Arquivos ao Vivo</TabsTrigger>
            <TabsTrigger value="files">Editor</TabsTrigger>
          </TabsList>
          <TabsContent value="preview" keepMounted className="flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden data-[hidden]:hidden">{checkpointPreview && !hasDraft && checkpointPreview.base_revision_id === project.current_revision_id && <p role="status" className="px-4 py-2 text-xs text-muted-foreground">Rascunho confirmado do agente. Build e aprovação visual ainda pendentes; a revisão salva permanece intacta.</p>}<SitePreview files={!hasDraft && checkpointPreview?.base_revision_id === project.current_revision_id ? checkpointPreview.files : snapshot.files} projectScope={project} revisionId={project.current_revision_id} projectSlug={project.slug} projectName={project.name} /></TabsContent>
          <TabsContent value="realtime" keepMounted className="flex-1 min-h-0 min-w-0 overflow-auto data-[hidden]:hidden">
            <RealtimeFilesViewer
              files={!hasDraft && checkpointPreview?.base_revision_id === project.current_revision_id ? checkpointPreview.files : snapshot.files}
              previousFiles={previousFiles ?? undefined}
              isGenerating={hasActive}
              projectName={project.name}
            />
          </TabsContent>
          <TabsContent value="files" keepMounted className="flex-1 min-h-0 min-w-0 overflow-auto data-[hidden]:hidden"><SiteFilesPanel draftScope={draftScope} projectId={projectId} files={snapshot.files} currentRevisionId={project.current_revision_id} onSaved={reload} onDirtyChange={setFilesDirty} onMutationStart={beginMutation} onMutationEnd={endMutation} disabled={disabled} /></TabsContent>
        </Tabs>
      </section>
      <aside id="editor-settings" role="tabpanel" tabIndex={0} aria-label="Ajustes do projeto" className={`${tab === "settings" ? "block" : "hidden"} h-full min-h-0 overflow-auto border-l border-border lg:block`}><SiteProjectPanel draftScope={draftScope} project={project} runs={runs} disabled={disabled} filesDirty={filesDirty} refresh={refresh} onDirtyChange={setSettingsDirty} onFilesChanged={reload} onMutationStart={beginMutation} onMutationEnd={endMutation} onPublish={() => void publishOrValidate(true)} onRollback={(id) => void rollback(id)} /></aside>
    </div>
  </div>;
}
