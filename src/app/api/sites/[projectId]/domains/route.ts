import { NextRequest, NextResponse } from "next/server";
import { getProject } from "@/lib/sites/repository";
import { createSiteDeploymentProvider, reserveSiteDomain } from "@/lib/sites/deployment-provider";
import { getWebsiteSettings } from "@/lib/sites/prompts";
import { requireSitesContext, SitesError, sitesErrorResponse } from "@/lib/sites/server";

type Context = { params: Promise<{ projectId: string }> };
export const runtime = "nodejs";

export async function GET(req: NextRequest, context: Context): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    const project = await getProject(ctx.clientId, (await context.params).projectId);
    const { data, error } = await ctx.db.from("website_domains").select("id,client_id,project_id,hostname,status,created_at")
      .eq("client_id", ctx.clientId).eq("project_id", project.id).order("created_at", { ascending: false }).limit(20);
    if (error) throw new SitesError(503, "Não foi possível carregar os domínios.");
    const configured = createSiteDeploymentProvider().configured();
    return NextResponse.json({ domains: data ?? [], readiness: configured ? "configured" : "READY — AWAITING CREDENTIALS" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return sitesErrorResponse(error); }
}

export async function POST(req: NextRequest, context: Context): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    const project = await getProject(ctx.clientId, (await context.params).projectId);
    if (project.status === "archived") throw new SitesError(409, "Projeto arquivado.");
    const settings = await getWebsiteSettings();
    const provider = createSiteDeploymentProvider();
    if (!provider.configured()) throw new SitesError(503, "READY — AWAITING CREDENTIALS");
    const domain = await reserveSiteDomain(project, settings.base_domain, provider);
    return NextResponse.json({ domain }, { status: domain.status === "active" ? 200 : 202 });
  } catch (error) { return sitesErrorResponse(error); }
}
