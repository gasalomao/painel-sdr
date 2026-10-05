import { NextRequest, NextResponse } from "next/server";
import { getProject } from "@/lib/sites/repository";
import { publishSite } from "@/lib/sites/deployment-provider";
import { getWebsiteSettings } from "@/lib/sites/prompts";
import { assertUuid, onlyFields, readSitesBody, requireSitesContext, SitesError, sitesErrorResponse } from "@/lib/sites/server";

type Context = { params: Promise<{ projectId: string }> };
export const runtime = "nodejs";

export async function GET(req: NextRequest, context: Context): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    const project = await getProject(ctx.clientId, (await context.params).projectId);
    const { data, error } = await ctx.db.from("website_deployments").select("id,client_id,project_id,build_id,provider,status,provider_id,url,error,created_at")
      .eq("client_id", ctx.clientId).eq("project_id", project.id).order("created_at", { ascending: false }).limit(100);
    if (error) throw new SitesError(503, "Não foi possível carregar as publicações.");
    return NextResponse.json({ deployments: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return sitesErrorResponse(error); }
}

export async function POST(req: NextRequest, context: Context): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    const body = await readSitesBody(req, 1024);
    onlyFields(body, ["build_id"]);
    assertUuid(body.build_id);
    const settings = await getWebsiteSettings();
    const deployment = await publishSite({ clientId: ctx.clientId, projectId: (await context.params).projectId, buildId: body.build_id, idempotencyKey: req.headers.get("idempotency-key") ?? "", baseDomain: settings.base_domain });
    return NextResponse.json({ deployment }, { status: deployment.status === "deploying" ? 202 : deployment.status === "failed" ? 409 : 200 });
  } catch (error) { return sitesErrorResponse(error); }
}
