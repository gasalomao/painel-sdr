import { NextRequest, NextResponse } from "next/server";
import { getProject } from "@/lib/sites/repository";
import { onlyFields, readSitesBody, requireSitesContext, SitesError, sitesErrorResponse } from "@/lib/sites/server";
import type { WebsiteBuild } from "@/lib/sites/types";

type Context = { params: Promise<{ projectId: string }> };
export const runtime = "nodejs";

export async function GET(req: NextRequest, context: Context): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    const project = await getProject(ctx.clientId, (await context.params).projectId);
    const { data, error } = await ctx.db.from("website_builds").select("id,client_id,project_id,revision_id,status,success,logs,errors,warnings,duration_ms,screenshots,qa,created_at")
      .eq("client_id", ctx.clientId).eq("project_id", project.id).order("created_at", { ascending: false }).limit(10);
    if (error) throw new SitesError(503, "Não foi possível carregar os builds.");
    // ponytail: screenshots base64 pesam centenas de KB por build; só o build mais recente e os da revisão
    // atual saem completos (thumb da lista + checagem de reuso de publicação). Upgrade: endpoint de screenshot sob demanda.
    const builds = ((data ?? []) as Omit<WebsiteBuild, "artifact">[]).map((build, index) =>
      index === 0 || build.revision_id === project.current_revision_id ? build : { ...build, screenshots: {} });
    return NextResponse.json({ builds }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return sitesErrorResponse(error); }
}

export async function POST(req: NextRequest, context: Context): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    const project = await getProject(ctx.clientId, (await context.params).projectId);
    const body = await readSitesBody(req, 1024);
    onlyFields(body, ["expected_revision_id"]);
    if (!project.current_revision_id || project.status === "archived" || body.expected_revision_id !== project.current_revision_id) throw new SitesError(409, "Revisão atual divergente ou projeto arquivado.");
    if (!process.env.E2B_API_KEY || !process.env.E2B_SITE_TEMPLATE_ID) throw new SitesError(503, "READY — AWAITING CREDENTIALS");
    const { data, error } = await ctx.db.rpc("website_queue_build", { p_client_id: ctx.clientId, p_project_id: project.id, p_actor_id: ctx.actorId, p_expected_revision_id: project.current_revision_id });
    const code = error?.message === "website_active_run" ? 409 : error?.message === "website_revision_conflict" ? 409 : error?.message === "website_quota_exceeded" ? 429 : 503;
    if (error || !data) throw new SitesError(code, code === 429 ? "Limite diário de builds atingido." : code === 409 ? "Já existe uma execução ativa neste projeto." : "Build não enfileirado; verifique configuração do worker.");
    return NextResponse.json({ run: data }, { status: 202 });
  } catch (error) { return sitesErrorResponse(error); }
}
