import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { NextRequest, NextResponse } from "next/server";
import { assertUuid, getSitesDb, onlyFields, readSitesBody, SitesError, sitesErrorResponse, textField } from "./server";

export interface WebsiteFormPayload {
  project_id: string;
  idempotency_key: string;
  name: string;
  email: string;
  phone: string;
  message: string;
  consent: true;
  company: string;
}

export function validateWebsiteForm(body: Record<string, unknown>): WebsiteFormPayload {
  onlyFields(body, ["project_id", "idempotency_key", "name", "email", "phone", "message", "consent", "company"]);
  assertUuid(body.project_id);
  const key = textField(body.idempotency_key, 128, true);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new SitesError(400, "Chave de envio inválida.");
  const name = textField(body.name, 120, true);
  const email = textField(body.email ?? "", 254).toLowerCase();
  const phone = textField(body.phone ?? "", 30);
  const message = textField(body.message ?? "", 3000);
  const company = textField(body.company ?? "", 200);
  if (name.length < 2 || (!email && !phone) || (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) ||
    (phone && (!/^[+\d ()-]+$/.test(phone) || !/^\d{10,15}$/.test(phone.replace(/\D/g, "")))) ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(name + email + phone + message)) throw new SitesError(400, "Dados de contato inválidos.");
  if (body.consent !== true && body.consent !== "true") throw new SitesError(400, "Autorize o contato para enviar.");
  return { project_id: body.project_id, idempotency_key: key, name, email, phone, message, consent: true, company };
}

export function isExactWebsiteOrigin(origin: string | null, urls: string[]): boolean {
  if (!origin || origin === "null") return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" && parsed.origin === origin && !parsed.username && !parsed.password &&
      urls.some((url) => { try { return new URL(url).origin === origin; } catch { return false; } });
  } catch { return false; }
}

async function publishedFormContext(projectId: string, origin: string | null): Promise<{ clientId: string; origin: string }> {
  assertUuid(projectId);
  const db = getSitesDb();
  const { data: project, error } = await db.from("website_projects").select("id,client_id,published_deployment_id")
    .eq("id", projectId).eq("status", "published").is("deleted_at", null).maybeSingle();
  if (error) throw new SitesError(503, "Formulário temporariamente indisponível.");
  if (!project?.published_deployment_id) throw new SitesError(404, "Formulário indisponível.");
  const { data: client, error: clientError } = await db.from("clients").select("id,is_active,features,is_admin").eq("id", project.client_id).maybeSingle();
  if (clientError) throw new SitesError(503, "Formulário temporariamente indisponível.");
  if (!client?.is_active || (!client.is_admin && client.features?.sites !== true)) throw new SitesError(404, "Formulário indisponível.");
  const { data: deployment, error: deployError } = await db.from("website_deployments").select("url")
    .eq("client_id", project.client_id).eq("project_id", projectId).eq("id", project.published_deployment_id).eq("status", "published").maybeSingle();
  const { data: domains, error: domainError } = await db.from("website_domains").select("hostname")
    .eq("client_id", project.client_id).eq("project_id", projectId).eq("status", "active");
  if (deployError || domainError) throw new SitesError(503, "Formulário temporariamente indisponível.");
  if (!deployment?.url) throw new SitesError(404, "Formulário indisponível.");
  const urls = [deployment.url, ...(domains ?? []).map((domain: { hostname: string }) => `https://${domain.hostname}`)];
  if (!isExactWebsiteOrigin(origin, urls)) throw new SitesError(403, "Origem não permitida.");
  return { clientId: project.client_id, origin: origin! };
}

function cors(origin: string): Record<string, string> {
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600", Vary: "Origin", "Cache-Control": "no-store" };
}

async function admitForm(key: string, limit: number): Promise<void> {
  const { data, error } = await getSitesDb().rpc("website_rate_limit", { key, limit, window_seconds: 600 });
  if (error) throw new SitesError(503, "Formulário temporariamente indisponível.");
  if (data !== true) throw new SitesError(429, "Muitos envios. Tente novamente mais tarde.");
}

export async function websiteFormPreflight(req: NextRequest): Promise<NextResponse> {
  try {
    const requested = req.headers.get("access-control-request-headers")?.toLowerCase().split(",").map((value) => value.trim()) ?? [];
    if (req.headers.get("access-control-request-method") !== "POST" || requested.some((value) => value !== "content-type")) throw new SitesError(403, "Preflight não permitido.");
    const projectId = req.nextUrl.searchParams.get("project_id");
    assertUuid(projectId);
    const context = await publishedFormContext(projectId, req.headers.get("origin"));
    return new NextResponse(null, { status: 204, headers: cors(context.origin) });
  } catch (error) { return sitesErrorResponse(error); }
}

export async function submitWebsiteForm(req: NextRequest): Promise<NextResponse> {
  let allowedOrigin: string | undefined;
  try {
    const body = await readSitesBody(req, 8192);
    const queryProjectId = req.nextUrl.searchParams.get("project_id");
    if (queryProjectId && body.project_id && queryProjectId !== body.project_id) throw new SitesError(400, "Projeto divergente.");
    const payload = validateWebsiteForm({ ...body, project_id: body.project_id ?? queryProjectId });
    const context = await publishedFormContext(payload.project_id, req.headers.get("origin"));
    allowedOrigin = context.origin;
    await admitForm(`form:project:${context.clientId}:${payload.project_id}`, 100);
    const trustedHeader = process.env.SITE_FORMS_TRUSTED_IP_HEADER;
    const address = trustedHeader ? req.headers.get(trustedHeader) : null;
    const identity = address && isIP(address) ? createHash("sha256").update(`${payload.project_id}:${address}`).digest("hex") : "unknown";
    await admitForm(`form:ip:${payload.project_id}:${identity}`, 10);
    if (payload.company) return NextResponse.json({ ok: true }, { status: 202, headers: cors(context.origin) });
    const { project_id, idempotency_key, name, email, phone, message, consent } = payload;
    const { data, error } = await getSitesDb().rpc("website_submit_form", {
      p_client_id: context.clientId, p_project_id: project_id, p_idempotency_key: idempotency_key,
      p_payload: { name, email, phone, message, consent },
    });
    if (error) {
      const conflict = error.code === "23505" || (error.message ?? "").includes("website_idempotency_conflict");
      throw new SitesError(conflict ? 409 : 503, conflict ? "Chave de envio já utilizada para outros dados." : "Não foi possível salvar. Tente novamente com a mesma chave de envio.");
    }
    if (!data || typeof data.id !== "string") throw new SitesError(503, "Confirmação de envio indisponível. Preserve a chave e tente novamente.");
    return NextResponse.json({ ok: true }, { status: 202, headers: cors(context.origin) });
  } catch (error) {
    const response = sitesErrorResponse(error);
    if (allowedOrigin) for (const [key, value] of Object.entries(cors(allowedOrigin))) response.headers.set(key, value);
    if (error instanceof SitesError && error.status === 429) response.headers.set("Retry-After", "600");
    return response;
  }
}
