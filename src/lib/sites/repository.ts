import { randomUUID } from "node:crypto";
import { getCleanStarterFiles, getStarterFiles, WEBSITE_FIXED_FILES } from "./starter";
import { normalizeWebsitePath, validateFiles } from "./validation";
import { assertUuid, getSitesDb, objectBody, onlyFields, requireSitesProject, SitesError, textField } from "./server";
import type { WebsiteClientContext, WebsiteFiles, WebsiteMessage, WebsiteProject, WebsiteRevision, WebsiteRun } from "./types";

const CONTEXT_FIELDS = ["name", "segment", "phone", "whatsapp", "website", "city", "address", "description", "services", "notes"] as const;
const PROJECT_FIELDS = ["name", "slug", "lead_id", "client_context", "instructions", "model_mode", "model_id", "selected_skill_ids", "cta", "status"] as const;
const LEAD_COLUMNS = "id,nome_negocio,ramo_negocio,telefone,website,endereco,categoria";

export function databaseError(error: { message?: string; code?: string } | null): void {
  if (!error) return;
  const errors: Record<string, [number, string]> = {
    website_not_found: [404, "Registro não encontrado."],
    website_revision_conflict: [409, "O projeto mudou. Atualize antes de salvar."],
    website_active_run: [409, "Já existe uma execução ativa neste projeto."],
    website_quota_exceeded: [429, "Limite do Site Studio atingido."],
    website_invalid_input: [400, "Dados inválidos."],
    website_lease_lost: [409, "A concessão da execução expirou."],
    website_forbidden: [403, "Acesso não permitido."],
  };
  const mapped = errors[error.message ?? ""];
  if (mapped) throw new SitesError(...mapped);
  if (error.code === "23505") throw new SitesError(409, "Conflito com um registro existente.");
  if (error.code === "23503") throw new SitesError(409, "Vínculo inválido ou registro alterado.");
  throw new SitesError(503, "Não foi possível persistir ou consultar os dados.");
}

function checkedFiles(value: unknown): WebsiteFiles {
  const input = objectBody(value);
  const files: WebsiteFiles = {};
  try {
    for (const [path, content] of Object.entries(input)) {
      if (typeof content !== "string") throw new Error("invalid");
      const normalized = Object.hasOwn(WEBSITE_FIXED_FILES, path) ? path : normalizeWebsitePath(path);
      files[normalized] = content;
    }
    validateFiles(files);
  } catch {
    throw new SitesError(400, "Arquivos inválidos, configuração alterada ou limite excedido.");
  }
  return files;
}

function uuidList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 30) throw new SitesError(400, "Lista de identificadores inválida.");
  value.forEach(assertUuid);
  return [...new Set(value as string[])];
}

export function validateProjectInput(value: unknown, partial = false): Partial<WebsiteProject> {
  const body = objectBody(value);
  onlyFields(body, partial ? PROJECT_FIELDS.filter((field) => field !== "lead_id") : PROJECT_FIELDS);
  const result: Partial<WebsiteProject> = {};
  if (!partial || body.name !== undefined) result.name = textField(body.name, 120, true);
  if (body.slug !== undefined) {
    const slug = textField(body.slug, 80, true);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new SitesError(400, "Slug inválido.");
    result.slug = slug;
  }
  if (body.lead_id !== undefined) {
    if (body.lead_id !== null && (typeof body.lead_id !== "number" || !Number.isSafeInteger(body.lead_id) || body.lead_id <= 0)) {
      throw new SitesError(400, "Lead inválido.");
    }
    result.lead_id = body.lead_id as number | null;
  }
  if (body.client_context !== undefined) {
    const context = objectBody(body.client_context);
    onlyFields(context, CONTEXT_FIELDS);
    result.client_context = Object.fromEntries(Object.entries(context).map(([key, val]) => [key, textField(val, 4000)])) as WebsiteClientContext;
  }
  if (body.instructions !== undefined) result.instructions = textField(body.instructions, 16000);
  if (body.model_mode !== undefined) {
    if (!["auto", "quality", "economy", "manual"].includes(String(body.model_mode))) throw new SitesError(400, "Modo de modelo inválido.");
    result.model_mode = body.model_mode as WebsiteProject["model_mode"];
  }
  if (body.model_id !== undefined) result.model_id = body.model_id === null ? null : textField(body.model_id, 160, true);
  if (body.selected_skill_ids !== undefined) result.selected_skill_ids = uuidList(body.selected_skill_ids);
  if (body.status !== undefined) {
    if (!["draft", "archived"].includes(String(body.status))) throw new SitesError(400, "Estado inválido.");
    result.status = body.status as "draft" | "archived";
  }
  if (body.cta !== undefined) {
    const cta = objectBody(body.cta);
    onlyFields(cta, ["type", "value"]);
    if (!["whatsapp", "form", "phone", "calendar", "url"].includes(String(cta.type))) throw new SitesError(400, "CTA inválido.");
    const text = textField(cta.value, 2048);
    if (text && ["url", "calendar"].includes(String(cta.type))) {
      try {
        const url = new URL(text);
        if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid");
      } catch { throw new SitesError(400, "URL de CTA inválida."); }
    }
    if (text && ["phone", "whatsapp"].includes(String(cta.type)) && !/^\+?[\d ()-]{7,30}$/.test(text)) throw new SitesError(400, "Telefone de CTA inválido.");
    result.cta = { type: cta.type as WebsiteProject["cta"]["type"], value: text };
  }
  return result;
}

export async function getProject(clientId: string, projectId: string): Promise<WebsiteProject> {
  return requireSitesProject(clientId, projectId);
}

export async function listProjects(clientId: string): Promise<WebsiteProject[]> {
  assertUuid(clientId);
  const { data, error } = await getSitesDb().from("website_projects").select("*")
    .eq("client_id", clientId).is("deleted_at", null).order("updated_at", { ascending: false }).limit(200);
  databaseError(error);
  return (data ?? []) as WebsiteProject[];
}

export async function createProject(clientId: string, value: unknown, actorId: string): Promise<WebsiteProject> {
  assertUuid(clientId);
  assertUuid(actorId);
  const input = validateProjectInput(value);
  if (input.lead_id) {
    const { data, error } = await getSitesDb().from("leads_extraidos").select("id")
      .eq("client_id", clientId).eq("id", input.lead_id).maybeSingle();
    databaseError(error);
    if (!data) throw new SitesError(404, "Lead não encontrado.");
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const project: WebsiteProject = {
    id, client_id: clientId, name: input.name!, slug: input.slug ?? `site-${id.slice(0, 8)}`,
    lead_id: null, client_context: {}, instructions: "", model_mode: "auto", model_id: null,
    selected_skill_ids: [], cta: { type: "whatsapp", value: "" }, status: "draft",
    current_revision_id: null, published_deployment_id: null, published_url: null, last_published_at: null,
    created_at: now, updated_at: now, deleted_at: null, ...input,
  };
  const files = checkedFiles(getCleanStarterFiles(project));
  const { data, error } = await getSitesDb().rpc("website_create_project", {
    p_client_id: clientId, p_actor_id: actorId, p_project: project, p_files: files,
  });
  databaseError(error);
  if (!data) throw new SitesError(503, "Não foi possível criar o projeto.");
  return data as WebsiteProject;
}

export async function updateProject(clientId: string, projectId: string, value: unknown): Promise<WebsiteProject> {
  await getProject(clientId, projectId);
  const patch = validateProjectInput(value, true);
  if (!Object.keys(patch).length) throw new SitesError(400, "Nenhuma alteração informada.");
  const { data, error } = await getSitesDb().rpc("website_update_project", { p_client_id: clientId, p_project_id: projectId, p_patch: patch });
  databaseError(error);
  return data as WebsiteProject;
}

export async function deleteProject(clientId: string, projectId: string): Promise<WebsiteProject> {
  await getProject(clientId, projectId);
  const { data, error } = await getSitesDb().rpc("website_delete_project", { p_client_id: clientId, p_project_id: projectId });
  databaseError(error);
  return data as WebsiteProject;
}

export async function getFiles(clientId: string, projectId: string): Promise<WebsiteFiles> {
  const project = await getProject(clientId, projectId);
  if (!project.current_revision_id) return {};
  const { data, error } = await getSitesDb().from("website_revisions").select("files")
    .eq("client_id", clientId).eq("project_id", projectId).eq("id", project.current_revision_id).maybeSingle();
  databaseError(error);
  if (!data) throw new SitesError(409, "Snapshot atual indisponível.");
  return data.files as WebsiteFiles;
}

export async function saveRevision(clientId: string, projectId: string, files: WebsiteFiles, message: string, actorId: string, expectedRevisionId: string | null): Promise<WebsiteRevision> {
  await getProject(clientId, projectId);
  assertUuid(actorId);
  if (expectedRevisionId !== null) assertUuid(expectedRevisionId);
  const snapshot = checkedFiles(files);
  const { data, error } = await getSitesDb().rpc("website_save_revision", {
    p_client_id: clientId, p_project_id: projectId, p_files: snapshot,
    p_message: textField(message, 1000, true), p_actor_id: actorId, p_expected_revision_id: expectedRevisionId,
  });
  databaseError(error);
  if (!data) throw new SitesError(503, "Não foi possível salvar a revisão.");
  return data as WebsiteRevision;
}

export async function listRevisions(clientId: string, projectId: string): Promise<Omit<WebsiteRevision, "files">[]> {
  await getProject(clientId, projectId);
  const { data, error } = await getSitesDb().from("website_revisions")
    .select("id,client_id,project_id,parent_id,message,hash,created_at,actor_id")
    .eq("client_id", clientId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(100);
  databaseError(error);
  return data ?? [];
}

export async function restoreRevision(clientId: string, projectId: string, revisionId: string, actorId: string, expectedRevisionId: string | null): Promise<WebsiteRevision> {
  await getProject(clientId, projectId);
  assertUuid(revisionId);
  const { data, error } = await getSitesDb().from("website_revisions").select("files")
    .eq("client_id", clientId).eq("project_id", projectId).eq("id", revisionId).maybeSingle();
  databaseError(error);
  if (!data) throw new SitesError(404, "Revisão não encontrada.");
  return saveRevision(clientId, projectId, data.files as WebsiteFiles, `Restauração ${revisionId}`, actorId, expectedRevisionId);
}

export type WebsiteLead = { id: number; nome_negocio: string | null; ramo_negocio: string | null; telefone: string | null; website: string | null; endereco: string | null; categoria: string | null };

export async function listLeads(clientId: string, search = ""): Promise<WebsiteLead[]> {
  assertUuid(clientId);
  const term = textField(search, 120);
  let query = getSitesDb().from("leads_extraidos").select(LEAD_COLUMNS).eq("client_id", clientId);
  if (term) query = query.ilike("nome_negocio", `%${term.replace(/[\\%_]/g, "\\$&")}%`);
  const { data, error } = await query.order("id", { ascending: false }).limit(50);
  databaseError(error);
  return (data ?? []) as WebsiteLead[];
}

export async function listRuns(clientId: string, projectId: string): Promise<WebsiteRun[]> {
  await getProject(clientId, projectId);
  const { data, error } = await getSitesDb().from("website_runs").select("*")
    .eq("client_id", clientId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(100);
  databaseError(error);
  return (data ?? []) as WebsiteRun[];
}

export async function queueRun(clientId: string, projectId: string, value: unknown, actorId: string): Promise<WebsiteRun> {
  const project = await getProject(clientId, projectId);
  assertUuid(actorId);
  const body = objectBody(value);
  onlyFields(body, ["prompt", "model_id", "asset_ids"]);
  const prompt = textField(body.prompt, 16000, true);
  const assets = body.asset_ids === undefined ? [] : uuidList(body.asset_ids);
  const modelId = body.model_id === undefined || body.model_id === null ? project.model_id : textField(body.model_id, 160, true);
  if (assets.length) {
    const { data, error } = await getSitesDb().from("website_assets").select("id")
      .eq("client_id", clientId).eq("project_id", projectId).in("id", assets);
    databaseError(error);
    if (!data || data.length !== assets.length) throw new SitesError(404, "Asset não encontrado.");
  }
  const { data, error } = await getSitesDb().rpc("website_queue_run", {
    p_client_id: clientId, p_project_id: projectId, p_actor_id: actorId, p_prompt: prompt,
    p_model_id: modelId, p_asset_ids: assets,
  });
  databaseError(error);
  if (!data) throw new SitesError(503, "Não foi possível enfileirar a execução.");
  return data as WebsiteRun;
}

export async function cancelRun(clientId: string, projectId: string, runId: string): Promise<WebsiteRun> {
  await getProject(clientId, projectId);
  assertUuid(runId);
  const { data, error } = await getSitesDb().rpc("website_cancel_run", { p_client_id: clientId, p_project_id: projectId, p_run_id: runId });
  databaseError(error);
  if (!data) throw new SitesError(503, "Não foi possível cancelar a execução.");
  return data as WebsiteRun;
}

export async function listMessages(clientId: string, projectId: string): Promise<WebsiteMessage[]> {
  await getProject(clientId, projectId);
  const { data, error } = await getSitesDb().from("website_messages").select("id,project_id,run_id,role,content,created_at")
    .eq("client_id", clientId).eq("project_id", projectId).not("content", "like", "[site-checkpoint:%").order("created_at", { ascending: false }).limit(200);
  databaseError(error);
  return (data ?? []).reverse() as WebsiteMessage[];
}

export async function claimRun(clientId: string, projectId: string, runId: string, workerId: string, leaseSeconds = 120): Promise<WebsiteRun | null> {
  [clientId, projectId, runId, workerId].forEach(assertUuid);
  const { data, error } = await getSitesDb().rpc("website_claim_run", {
    p_client_id: clientId, p_project_id: projectId, p_run_id: runId, p_worker_id: workerId, p_lease_seconds: leaseSeconds,
  });
  databaseError(error);
  return data as WebsiteRun | null;
}
