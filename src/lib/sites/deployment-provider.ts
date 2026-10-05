import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { assertUuid, getSitesDb, requireSitesProject, SitesError } from "./server";
import type { WebsiteArtifactFile, WebsiteBuild, WebsiteDeployment, WebsiteProject } from "./types";

const NOT_CONFIGURED = "READY — AWAITING CREDENTIALS";
const STATIC_WORKER = "export default { fetch(request, env) { return env.ASSETS.fetch(request); } };";
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DEPLOYMENT_PHASES = { reserved: 0, version_creating: 1, version_ready: 2, activating: 3 } as const;
const LEASE_SECONDS = 300;

type DeploymentExecution = { signal: AbortSignal; beforeRequest(): Promise<void> };

export interface SiteDomainResult { hostname: string; status: "active" | "pending"; url: string; readiness: string }
export interface SiteDeploymentProvider {
  configured(): boolean;
  hostname(project: WebsiteProject, baseDomain: string): string;
  configureDomain(project: WebsiteProject, baseDomain: string): Promise<SiteDomainResult>;
  prepareVersion(project: WebsiteProject, build: WebsiteBuild, deploymentId: string): Promise<FormData>;
  createVersion(project: WebsiteProject, prepared: FormData): Promise<string>;
  findVersion(project: WebsiteProject, deploymentId: string): Promise<string | null>;
  deploy(project: WebsiteProject, providerId: string): Promise<void>;
  rollback(project: WebsiteProject, providerId: string): Promise<void>;
  activeDeploymentVersion(project: WebsiteProject, providerId: string): Promise<boolean>;
  probePublishedSite(url: URL): Promise<void>;
}

export function siteWorkerName(project: Pick<WebsiteProject, "id" | "client_id">): string {
  assertUuid(project.id);
  assertUuid(project.client_id);
  return `site-${project.id.replaceAll("-", "")}`;
}

export function assertPublishableBuild(project: WebsiteProject, build: WebsiteBuild, rollback = false): void {
  if (project.deleted_at || project.status === "archived" || build.client_id !== project.client_id || build.project_id !== project.id ||
    (!rollback && build.revision_id !== project.current_revision_id) || !build.success || build.status !== "ready" ||
    !build.qa?.passed || build.errors.length || build.qa.errors.length || !build.qa.visual_review?.trim() ||
    !build.screenshots.desktop?.startsWith("data:image/png;base64,iVBOR") ||
    !build.screenshots.mobile?.startsWith("data:image/png;base64,iVBOR")) {
    throw new SitesError(409, "Publicação bloqueada: revisão, QA, screenshots e crítica visual precisam estar aprovados.");
  }
  createCloudflareManifest(build.artifact);
}

export function createCloudflareManifest(artifact: Record<string, WebsiteArtifactFile>): Record<string, { hash: string; size: number }> {
  if (!artifact || !artifact["/index.html"] || Object.keys(artifact).length > 500) throw new SitesError(400, "Artefato inválido.");
  const manifest: Record<string, { hash: string; size: number }> = {};
  const types: Record<string, string[]> = { html: ["text/html"], js: ["text/javascript", "application/javascript"], css: ["text/css"], json: ["application/json"], png: ["image/png"], jpg: ["image/jpeg"], jpeg: ["image/jpeg"], webp: ["image/webp"], avif: ["image/avif"], gif: ["image/gif"], svg: ["image/svg+xml"], ico: ["image/x-icon"], txt: ["text/plain"], woff: ["font/woff"], woff2: ["font/woff2"] };
  let total = 0;
  for (const [path, file] of Object.entries(artifact)) {
    if (!/^\/[A-Za-z0-9_./-]+$/.test(path) || path.length > 240 || path.slice(1).split("/").some((part) => !part || part.startsWith(".") || ["_worker.js", "_headers", "_redirects", "functions", "node_modules", "package.json"].includes(part))) throw new SitesError(400, "Caminho de artefato não permitido.");
    const extension = posix.extname(path).slice(1);
    if (!file || !types[extension]?.includes(file.mime) || typeof file.content !== "string" || file.content.length > 28 * 1024 * 1024) throw new SitesError(400, "Tipo de artefato não permitido.");
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.toString("base64") !== file.content || bytes.length > 20 * 1024 * 1024 || (total += bytes.length) > 40 * 1024 * 1024) throw new SitesError(400, "Artefato excede o limite ou base64 inválido.");
    manifest[path] = { hash: createHash("sha256").update(file.content + extension).digest("hex").slice(0, 32), size: bytes.length };
  }
  return manifest;
}

class CloudflareError extends SitesError {
  constructor(public upstreamStatus: number) { super(502, `Cloudflare indisponível (HTTP ${upstreamStatus}).`); }
}

function deploymentRpcError(error: { message?: string } | null): never {
  const mapped: Record<string, [number, string]> = {
    website_not_found: [404, "Build ou projeto não encontrado."],
    website_revision_conflict: [409, "O projeto mudou durante a publicação."],
    website_active_run: [409, "Existe execução ativa neste projeto."],
    website_active_deployment: [409, "Existe publicação em andamento neste projeto."],
    website_idempotency_conflict: [409, "Conflito de idempotência da publicação."],
    website_domain_conflict: [409, "Domínio reservado por outro projeto."],
    website_quota_exceeded: [429, "Limite diário de publicações atingido."],
    website_lease_lost: [409, "Publicação reassumida por outra execução."],
    website_forbidden: [403, "Acesso não permitido."],
    website_invalid_input: [400, "Dados de publicação inválidos."],
  };
  const entry = mapped[error?.message ?? ""];
  throw new SitesError(entry ? entry[0] : 503, entry ? entry[1] : "Não foi possível reservar a publicação.");
}

type DeploymentRow = WebsiteDeployment & { hostname: string; phase: keyof typeof DEPLOYMENT_PHASES; expected_revision_id: string; rollback_id: string | null };

class DeploymentRejected extends SitesError {}

export function createSiteDeploymentProvider(execution?: DeploymentExecution): SiteDeploymentProvider {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const zone = process.env.CLOUDFLARE_ZONE_ID;
  const configured = () => Boolean(token && account && /^[a-f0-9]{32}$/i.test(account));
  async function api<T>(path: string, method = "GET", body?: BodyInit, bearer = token): Promise<T> {
    if (!configured()) throw new SitesError(503, NOT_CONFIGURED);
    await execution?.beforeRequest();
    execution?.signal.throwIfAborted();
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method, body, redirect: "error", signal: execution ? AbortSignal.any([execution.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${bearer}`, ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}) },
    });
    execution?.signal.throwIfAborted();
    if (!response.ok) throw new CloudflareError(response.status);
    const envelope = await response.json() as { success: boolean; result: T };
    execution?.signal.throwIfAborted();
    if (!envelope.success || envelope.result === null || envelope.result === undefined) throw new CloudflareError(response.status);
    return envelope.result;
  }
  const accountPath = `/accounts/${account}/workers`;
  function hostname(project: WebsiteProject, baseDomain: string): string {
    if (zone && baseDomain) {
      if (!/^[a-f0-9]{32}$/i.test(zone) || !LABEL.test(project.slug) || baseDomain.length > 180 || baseDomain.split(".").length < 2 || !baseDomain.split(".").every((label) => LABEL.test(label))) throw new SitesError(400, "Domínio gerenciado inválido.");
      return `${project.slug}.${baseDomain}`;
    }
    const subdomain = process.env.CLOUDFLARE_WORKERS_SUBDOMAIN;
    if (!subdomain || !LABEL.test(subdomain)) throw new SitesError(503, NOT_CONFIGURED);
    return `${siteWorkerName(project)}.${subdomain}.workers.dev`;
  }
  async function activeDeploymentVersion(project: WebsiteProject, providerId: string): Promise<boolean> {
    assertUuid(providerId);
    const listed = await api<{ deployments: Array<{ versions: Array<{ version_id: string; percentage: number }> }> }>(`${accountPath}/scripts/${siteWorkerName(project)}/deployments`);
    if (!Array.isArray(listed?.deployments) || (listed.deployments.length && !Array.isArray(listed.deployments[0]?.versions))) throw new SitesError(502, "Estado ativo inválido no provedor.");
    const active = listed.deployments[0]?.versions ?? [];
    if ((listed.deployments.length && !active.length) || active.some((version) => !version || typeof version.version_id !== "string" || !Number.isFinite(version.percentage) || version.percentage < 0 || version.percentage > 100)) throw new SitesError(502, "Estado ativo inválido no provedor.");
    return active.length === 1 && active[0].version_id === providerId && active[0].percentage === 100;
  }
  async function findVersion(project: WebsiteProject, deploymentId: string): Promise<string | null> {
    assertUuid(deploymentId);
    const matches = new Set<string>();
    for (let page = 1; page <= 100; page += 1) {
      const listed = await api<{ items: Array<{ id: string; annotations?: Record<string, string> }> }>(`${accountPath}/scripts/${siteWorkerName(project)}/versions?page=${page}&per_page=100`);
      if (!Array.isArray(listed?.items)) throw new SitesError(502, "Lista de versões inválida no provedor.");
      for (const version of listed.items) {
        if (!version || typeof version !== "object") throw new SitesError(502, "Lista de versões inválida no provedor.");
        if (version.annotations?.["workers/tag"] === deploymentId.replaceAll("-", "") && version.annotations["workers/message"] === `deployment:${deploymentId}`) {
          try { assertUuid(version.id); } catch { throw new SitesError(502, "Lista de versões inválida no provedor."); }
          matches.add(version.id);
        }
      }
      if (matches.size > 1) throw new SitesError(503, "Múltiplas versões para a publicação; reconciliação manual necessária.");
      if (listed.items.length < 100) return matches.values().next().value ?? null;
    }
    throw new SitesError(503, "Listagem de versões incompleta; reconciliação manual necessária.");
  }
  async function probePublishedSite(url: URL): Promise<void> {
    if (url.protocol !== "https:" || url.hostname.length > 253 || url.username || url.password || url.port) throw new SitesError(502, "URL de publicação inválida.");
    await execution?.beforeRequest();
    execution?.signal.throwIfAborted();
    const response = await fetch(url, { method: "GET", redirect: "error", signal: execution ? AbortSignal.any([execution.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000), headers: { Accept: "text/html" } });
    execution?.signal.throwIfAborted();
    if (!response.ok || !response.headers.get("content-type")?.startsWith("text/html")) throw new SitesError(502, "Site ainda não está servindo conteúdo.");
  }
  async function deploy(project: WebsiteProject, providerId: string): Promise<void> {
    assertUuid(providerId);
    await api(`${accountPath}/scripts/${siteWorkerName(project)}/deployments`, "POST", JSON.stringify({ strategy: "percentage", versions: [{ version_id: providerId, percentage: 100 }] }));
  }
  return {
    configured, hostname, deploy, rollback: deploy, activeDeploymentVersion, probePublishedSite, findVersion,
    async configureDomain(project, baseDomain) {
      const host = hostname(project, baseDomain);
      const service = siteWorkerName(project);
      if (zone && baseDomain) {
        const attached = await api<{ hostname: string; service: string; cert_id: string; zone_id: string }>(`${accountPath}/domains`, "PUT", JSON.stringify({ hostname: host, service, zone_id: zone }));
        if (attached.hostname !== host || attached.service !== service || attached.zone_id !== zone) throw new SitesError(502, "Domínio não confirmado pelo provedor.");
        if (!/^[a-f0-9]{64}$/i.test(attached.cert_id)) throw new SitesError(502, "Certificado do domínio não emitido.");
        return { hostname: host, status: "pending", url: `https://${host}`, readiness: "Domínio anexado com certificado; aguarda validação de DNS/TLS." };
      }
      const accountSubdomain = await api<{ subdomain: string }>(`${accountPath}/subdomain`);
      if (accountSubdomain.subdomain !== process.env.CLOUDFLARE_WORKERS_SUBDOMAIN) throw new SitesError(409, "Subdomínio workers.dev não corresponde à conta.");
      const result = await api<{ enabled: boolean }>(`${accountPath}/scripts/${service}/subdomain`, "POST", JSON.stringify({ enabled: true, previews_enabled: false }));
      if (!result.enabled) throw new SitesError(502, "Subdomínio não habilitado.");
      return { hostname: host, status: "active", url: `https://${host}`, readiness: "Roteamento workers.dev habilitado pelo provedor." };
    },
    async prepareVersion(project, build, deploymentId) {
      assertUuid(deploymentId);
      assertPublishableBuild(project, build);
      const name = siteWorkerName(project);
      try { await api(`${accountPath}/workers/${name}`); } catch (error) {
        if (!(error instanceof CloudflareError) || error.upstreamStatus !== 404) throw error;
        await api(`${accountPath}/workers`, "POST", JSON.stringify({ name, subdomain: { enabled: false, previews_enabled: false } }));
      }
      const manifest = createCloudflareManifest(build.artifact);
      const session = await api<{ jwt: string; buckets: string[][] }>(`${accountPath}/scripts/${name}/assets-upload-session`, "POST", JSON.stringify({ manifest }));
      if (typeof session.jwt !== "string" || !session.jwt.trim() || !Array.isArray(session.buckets)) throw new SitesError(502, "Sessão de upload inválida.");
      const byHash = new Map(Object.entries(manifest).map(([path, value]) => [value.hash, build.artifact[path]]));
      let completion = session.buckets.length ? "" : session.jwt;
      for (const bucket of session.buckets) {
        if (!Array.isArray(bucket) || !bucket.length) throw new SitesError(502, "Bucket de upload inválido.");
        const form = new FormData();
        for (const hash of bucket) {
          const file = byHash.get(hash);
          if (!file) throw new SitesError(502, "Bucket de upload inválido.");
          form.append(hash, new Blob([file.content], { type: file.mime }), hash);
        }
        const upload = await api<{ jwt?: string }>(`${accountPath}/assets/upload?base64=true`, "POST", form, session.jwt);
        if (upload.jwt !== undefined) {
          if (typeof upload.jwt !== "string" || !upload.jwt.trim()) throw new SitesError(502, "Conclusão de upload inválida.");
          completion = upload.jwt;
        }
      }
      if (!completion) throw new SitesError(502, "Upload não concluído.");
      const form = new FormData();
      form.append("metadata", new Blob([JSON.stringify({ main_module: "static.mjs", compatibility_date: "2026-09-01", bindings: [{ type: "assets", name: "ASSETS" }], assets: { jwt: completion, config: { html_handling: "auto-trailing-slash", not_found_handling: "none" } }, annotations: { "workers/tag": deploymentId.replaceAll("-", ""), "workers/message": `deployment:${deploymentId}` } })], { type: "application/json" }));
      form.append("static.mjs", new Blob([STATIC_WORKER], { type: "application/javascript+module" }), "static.mjs");
      return form;
    },
    async createVersion(project, prepared) {
      const version = await api<{ id: string }>(`${accountPath}/scripts/${siteWorkerName(project)}/versions`, "POST", prepared);
      try { assertUuid(version.id); } catch { throw new SitesError(502, "Versão inválida no provedor."); }
      return version.id;
    },
  };
}

function baseDomainFor(project: WebsiteProject, hostname: string): string {
  return hostname.startsWith(`${project.slug}.`) ? hostname.slice(project.slug.length + 1) : "";
}

function deploymentRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(10_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function deploymentLease(clientId: string, projectId: string, deploymentId: string, claimId: string, signal?: AbortSignal) {
  const controller = new AbortController();
  const leaseSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let pending: Promise<void> | null = null;
  const renew = (): Promise<void> => {
    leaseSignal.throwIfAborted();
    if (pending) return pending;
    pending = (async () => {
      const requestSignal = deploymentRequestSignal(leaseSignal);
      try {
        const result = await getSitesDb().rpc("website_renew_deployment", {
          p_client_id: clientId, p_project_id: projectId, p_deployment_id: deploymentId, p_claim_id: claimId, p_lease_seconds: LEASE_SECONDS,
        }).abortSignal(requestSignal);
        requestSignal.throwIfAborted();
        if (result.error || result.data !== true) deploymentRpcError(result.error ?? { message: "website_lease_lost" });
      } catch (error) {
        const reason = leaseSignal.aborted ? leaseSignal.reason : requestSignal.aborted ? new SitesError(503, "Renovação da publicação não confirmada.") : error;
        controller.abort(reason);
        throw reason;
      }
    })().finally(() => { pending = null; });
    return pending;
  };
  const heartbeat = setInterval(() => { if (!leaseSignal.aborted) void renew().catch(() => undefined); }, 60_000);
  heartbeat.unref?.();
  return {
    signal: leaseSignal, beforeRequest: renew,
    stop() { clearInterval(heartbeat); },
  };
}

async function finishDeployment(deployment: DeploymentRow & { claim_id: string }, clientId: string, projectId: string, status: "published" | "deploying" | "failed", error: string | null, signal: AbortSignal = deploymentRequestSignal()): Promise<DeploymentRow> {
  signal.throwIfAborted();
  const { data, error: rpcError } = await getSitesDb().rpc("website_finish_deployment", {
    p_client_id: clientId, p_project_id: projectId, p_deployment_id: deployment.id, p_claim_id: deployment.claim_id,
    p_status: status, p_error: error,
  }).abortSignal(signal);
  signal.throwIfAborted();
  if (rpcError) deploymentRpcError(rpcError);
  return (Array.isArray(data) ? data[0] : data) as DeploymentRow;
}

export async function resumeSiteDeployment(clientId: string, projectId: string, deploymentId: string, signal?: AbortSignal): Promise<WebsiteDeployment> {
  assertUuid(clientId);
  assertUuid(projectId);
  assertUuid(deploymentId);
  signal?.throwIfAborted();
  const db = getSitesDb();
  if (!createSiteDeploymentProvider().configured()) throw new SitesError(503, NOT_CONFIGURED);
  const claimId = randomUUID();
  const claimSignal = deploymentRequestSignal(signal);
  const { data: claimed, error: claimError } = await db.rpc("website_claim_deployment", {
    p_client_id: clientId, p_project_id: projectId, p_deployment_id: deploymentId, p_claim_id: claimId, p_lease_seconds: LEASE_SECONDS,
  }).abortSignal(claimSignal);
  claimSignal.throwIfAborted();
  if (claimError) deploymentRpcError(claimError);
  let row = (Array.isArray(claimed) ? claimed[0] : claimed) as (DeploymentRow & { claim_id: string }) | null;
  if (!row) throw new SitesError(409, "Publicação em andamento por outra execução.");
  const lease = deploymentLease(clientId, projectId, deploymentId, claimId, signal);
  const provider = createSiteDeploymentProvider(lease);
  let safePreActivation = row.phase === "reserved" || row.phase === "version_ready";
  let requestSignal = lease.signal;
  const checkpoint = async (phase: DeploymentRow["phase"], providerId: string | null): Promise<DeploymentRow & { claim_id: string }> => {
    await lease.beforeRequest();
    lease.signal.throwIfAborted();
    requestSignal = deploymentRequestSignal(lease.signal);
    const { data, error } = await db.rpc("website_checkpoint_deployment", {
      p_client_id: clientId, p_project_id: projectId, p_deployment_id: deploymentId, p_claim_id: claimId, p_provider_id: providerId, p_phase: phase,
    }).abortSignal(requestSignal);
    requestSignal.throwIfAborted();
    requestSignal = lease.signal;
    if (error) deploymentRpcError(error);
    const saved = (Array.isArray(data) ? data[0] : data) as DeploymentRow & { claim_id: string };
    if (!saved || saved.claim_id !== claimId || saved.phase !== phase || saved.provider_id !== providerId) throw new SitesError(503, "Checkpoint da publicação não confirmado.");
    return saved;
  };
  try {
    requestSignal = deploymentRequestSignal(lease.signal);
    const { data: projectData, error: projectError } = await db.from("website_projects").select("*")
      .eq("client_id", clientId).eq("id", projectId).is("deleted_at", null).abortSignal(requestSignal).maybeSingle();
    requestSignal.throwIfAborted();
    requestSignal = lease.signal;
    if (projectError) throw new SitesError(503, "Não foi possível carregar o projeto.");
    if (!projectData) throw new SitesError(404, "Projeto não encontrado.");
    const project = projectData as WebsiteProject;
    if (provider.hostname(project, baseDomainFor(project, row.hostname)) !== row.hostname) throw new SitesError(502, "Hostname divergente da configuração atual.");
    if (!(row.phase in DEPLOYMENT_PHASES)) throw new SitesError(503, "Fase de publicação desconhecida.");
    if (!row.provider_id) {
      let versionId: string;
      if (row.phase === "version_creating") {
        const found = await provider.findVersion(project, deploymentId);
        lease.signal.throwIfAborted();
        if (!found) throw new SitesError(503, "Criação externa ambígua; versão ainda não localizada. Recriação automática bloqueada.");
        versionId = found;
      } else {
        if (row.phase !== "reserved") throw new SitesError(503, "Versão do provedor ausente.");
        requestSignal = deploymentRequestSignal(lease.signal);
        const { data: buildData, error: buildError } = await db.from("website_builds").select("*").eq("client_id", clientId).eq("project_id", projectId).eq("id", row.build_id).abortSignal(requestSignal).maybeSingle();
        requestSignal.throwIfAborted();
        requestSignal = lease.signal;
        if (buildError || !buildData) throw new SitesError(503, "Build não encontrado para retomar.");
        const prepared = await provider.prepareVersion(project, buildData as WebsiteBuild, deploymentId);
        lease.signal.throwIfAborted();
        safePreActivation = false;
        row = await checkpoint("version_creating", null);
        lease.signal.throwIfAborted();
        try {
          versionId = await provider.createVersion(project, prepared);
          lease.signal.throwIfAborted();
        } catch (error) {
          if (definitiveProviderRejection(error)) throw new DeploymentRejected(502, error.message);
          throw error;
        }
      }
      row = await checkpoint("version_ready", versionId);
      lease.signal.throwIfAborted();
      safePreActivation = true;
    }
    if (!row.provider_id) throw new SitesError(503, "Versão do provedor ausente.");
    const active = await provider.activeDeploymentVersion(project, row.provider_id);
    lease.signal.throwIfAborted();
    if (active) safePreActivation = false;
    if (row.phase === "activating") {
      if (!active) throw new SitesError(503, "Ativação externa ambígua; reenvio automático bloqueado.");
    } else {
      if (row.phase !== "version_ready") throw new SitesError(503, "Fase de publicação inválida.");
      const domain = await provider.configureDomain(project, baseDomainFor(project, row.hostname));
      lease.signal.throwIfAborted();
      if (domain.hostname !== row.hostname) throw new SitesError(502, "Hostname divergente do domínio provisionado.");
      safePreActivation = false;
      row = await checkpoint("activating", row.provider_id);
      lease.signal.throwIfAborted();
      if (!active) await provider.deploy(project, row.provider_id!);
      lease.signal.throwIfAborted();
    }
    const confirmed = await provider.activeDeploymentVersion(project, row.provider_id!);
    lease.signal.throwIfAborted();
    if (!confirmed) throw new SitesError(503, "Ativação externa pendente de confirmação.");
    await provider.probePublishedSite(new URL(`https://${row.hostname}`));
    lease.signal.throwIfAborted();
    await lease.beforeRequest();
    lease.signal.throwIfAborted();
    lease.stop();
    requestSignal = deploymentRequestSignal(lease.signal);
    return await finishDeployment(row, clientId, projectId, "published", null, requestSignal);
  } catch (error) {
    lease.signal.throwIfAborted();
    requestSignal.throwIfAborted();
    const message = error instanceof SitesError ? error.message : "Publicação não concluída. Build e versão preservados.";
    const failed = error instanceof DeploymentRejected || (safePreActivation && (definitiveProviderRejection(error) || (error instanceof SitesError && [400, 404, 409].includes(error.status))));
    await lease.beforeRequest();
    lease.signal.throwIfAborted();
    lease.stop();
    requestSignal = deploymentRequestSignal(lease.signal);
    const pending = await finishDeployment(row, clientId, projectId, failed ? "failed" : "deploying", message, requestSignal).catch(() => null);
    requestSignal.throwIfAborted();
    if (pending) throw new SitesError(failed && error instanceof SitesError ? error.status : 503, message);
    throw error;
  } finally {
    lease.stop();
  }
}

function definitiveProviderRejection(error: unknown): error is CloudflareError {
  return error instanceof CloudflareError && [400, 401, 403, 404, 413, 415, 422].includes(error.upstreamStatus);
}

export async function reserveSiteDomain(project: WebsiteProject, baseDomain: string, provider = createSiteDeploymentProvider()): Promise<SiteDomainResult> {
  const db = getSitesDb();
  const hostname = provider.hostname(project, baseDomain);
  const { data: existing, error: readError } = await db.from("website_domains").select("id,status")
    .eq("client_id", project.client_id).eq("project_id", project.id).eq("hostname", hostname).maybeSingle();
  if (readError) throw new SitesError(503, "Não foi possível consultar o domínio.");
  if (!existing) {
    const { error } = await db.from("website_domains").insert({ client_id: project.client_id, project_id: project.id, hostname, status: "pending" });
    if (error) throw new SitesError(error.code === "23505" ? 409 : 503, "Domínio indisponível.");
  }
  const result = await provider.configureDomain(project, baseDomain);
  const status = existing?.status === "active" && result.status === "pending" ? "active" : result.status;
  const { error } = await db.from("website_domains").update({ status }).eq("client_id", project.client_id).eq("project_id", project.id).eq("hostname", hostname);
  if (error) throw new SitesError(503, "Domínio provisionado; reconciliação pendente.");
  return { ...result, status };
}

export async function publishSite(input: { clientId: string; projectId: string; buildId?: string; rollbackId?: string; idempotencyKey: string; baseDomain: string }): Promise<WebsiteDeployment> {
  const { clientId, projectId, idempotencyKey } = input;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) throw new SitesError(400, "Idempotency-Key inválida.");
  const db = getSitesDb();
  const project = await requireSitesProject(clientId, projectId);
  const provider = createSiteDeploymentProvider();
  if (!provider.configured()) throw new SitesError(503, NOT_CONFIGURED);
  const hostname = provider.hostname(project, input.baseDomain);
  let targetBuildId: string | null = null;
  let rollbackId: string | null = null;
  if (input.rollbackId) {
    assertUuid(input.rollbackId);
    const { data, error } = await db.from("website_deployments").select("id,build_id,provider_id,provider,status")
      .eq("client_id", clientId).eq("project_id", projectId).eq("id", input.rollbackId).eq("status", "published").maybeSingle();
    if (error) throw new SitesError(503, "Não foi possível carregar o deployment.");
    if (!data?.provider_id || data.provider !== "cloudflare") throw new SitesError(404, "Deployment não encontrado.");
    targetBuildId = data.build_id;
    rollbackId = data.id;
  } else {
    assertUuid(input.buildId);
    targetBuildId = input.buildId;
  }
  const { data: reserved, error: reserveError } = await db.rpc("website_begin_deployment", {
    p_client_id: clientId, p_project_id: projectId, p_build_id: targetBuildId, p_rollback_id: rollbackId,
    p_expected_revision_id: project.current_revision_id, p_idempotency_key: idempotencyKey, p_hostname: hostname,
  });
  if (reserveError) deploymentRpcError(reserveError);
  const deployment = (Array.isArray(reserved) ? reserved[0] : reserved) as DeploymentRow | null;
  if (!deployment) throw new SitesError(503, "Não foi possível reservar a publicação.");
  if (deployment.status !== "deploying") return deployment;
  return resumeSiteDeployment(clientId, projectId, deployment.id);
}
